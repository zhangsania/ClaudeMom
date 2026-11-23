import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import tls from "node:tls";
import { fileURLToPath } from "node:url";
import { crc32, gzipSync, gunzipSync } from "node:zlib";
import { startupAssets } from "./scripts/patch-dictation-start.mjs";
import { facadeFixture, recorderFixture } from "./scripts/fixtures/dictation-start.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const gatewayRequests = [];
const upstreamRequests = [];
const cdnAssetPath = "/claude-ai/v2/assets/v1/codex-fixture-AbCd1234.js";
const cdnAssetBody = gzipSync('export const fixture = "cached CDN bytes";');
const coworkPromptFixture = "<application_details>\nClaude test agent.\n</application_details>";
let gateway;
let upstreamFixture;
let upstreamFixturePort;
let proxy;
let proxyClosed;
let proxyPort;
let coworkPromptFile;
let dictationFixture;
let dictationFixturePort;
let dictationStateDir;
let dictationCacheDir;
let dictationAssetPath;
let dictationUpgrade;
let dictationFrame;
const streamFixtureSize = 4 * 1024 * 1024;

// 两个假的远程 MCP 服务器：mcp.demo.example 不用登录；mcp.auth.example 要 OAuth（授权服务器是 auth.example）。
const mcpFixture = { calls: [], registrations: [], tokenRequests: [], challenge: "", validTokens: new Set(["token-1"]), refreshes: true };

async function connectorFixture(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  const host = req.headers.host;
  const reply = (status, value, headers = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  };
  if (host === "auth.example") {
    if (req.url === "/.well-known/oauth-authorization-server") {
      return reply(200, {
        issuer: "https://auth.example", authorization_endpoint: "https://auth.example/authorize",
        token_endpoint: "https://auth.example/token", registration_endpoint: "https://auth.example/register",
      });
    }
    if (req.method === "POST" && req.url === "/register") {
      mcpFixture.registrations.push(JSON.parse(raw));
      return reply(201, { client_id: `client-${mcpFixture.registrations.length}` });
    }
    if (req.method === "POST" && req.url === "/token") {
      const form = Object.fromEntries(new URLSearchParams(raw));
      mcpFixture.tokenRequests.push(form);
      if (form.grant_type === "refresh_token" && form.refresh_token === "refresh-1" && mcpFixture.refreshes) {
        mcpFixture.validTokens.add("token-2");
        return reply(200, { access_token: "token-2", expires_in: 3600 });
      }
      const challenge = crypto.createHash("sha256").update(form.code_verifier ?? "").digest("base64url");
      if (form.grant_type === "authorization_code" && form.code === "code-1" && challenge === mcpFixture.challenge) {
        return reply(200, { access_token: "token-1", refresh_token: "refresh-1", expires_in: 3600 });
      }
      return reply(400, { error: "invalid_grant" });
    }
    return reply(404, { error: "not found" });
  }
  if (host === "mcp.auth.example" && req.url === "/.well-known/oauth-protected-resource/mcp") {
    return reply(200, { resource: "https://mcp.auth.example/mcp", authorization_servers: ["https://auth.example"], scopes_supported: ["read", "write"] });
  }
  if (req.method !== "POST" || req.url !== "/mcp") return reply(404, { error: "not found" });
  if (host === "mcp.auth.example" && !mcpFixture.validTokens.has(String(req.headers.authorization).replace("Bearer ", ""))) {
    return reply(401, { error: "unauthorized" }, {
      "www-authenticate": 'Bearer resource_metadata="https://mcp.auth.example/.well-known/oauth-protected-resource/mcp"',
    });
  }
  const message = JSON.parse(raw);
  const session = `session-${host}`;
  if (message.method === "initialize") {
    return reply(200, {
      jsonrpc: "2.0", id: message.id,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" }, instructions: "Use the echo tool." },
    }, { "mcp-session-id": session });
  }
  if (req.headers["mcp-session-id"] !== session) return reply(404, { error: "unknown session" });
  if (message.method === "notifications/initialized") return reply(202);
  if (message.method === "tools/list") {
    // 用 SSE 回，而且不结束连接：客户端拿到答案就该自己收手。
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.write(`event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      result: { tools: [{ name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { title: "Echo" } }] },
    })}\n\n`);
  }
  if (message.method === "tools/call") {
    mcpFixture.calls.push({ host, authorization: req.headers.authorization, params: message.params });
    return reply(200, {
      jsonrpc: "2.0", id: message.id,
      result: { content: [{ type: "text", text: `echo: ${message.params.arguments.text}` }], isError: false, structuredContent: { ok: true } },
    });
  }
  reply(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
}

/** 读「已连接的连接器」事件流：事件名 → 各次的 data。 */
async function connectorEvents() {
  const stream = await requestText("claude.ai", "/api/organizations/local/mcp/v2/bootstrap", { accept: "text/event-stream" });
  assert.equal(stream.status, 200);
  assert.match(stream.headers["content-type"], /text\/event-stream/);
  const events = {};
  for (const block of stream.body.split("\n\n").filter(Boolean)) {
    const [, name, data] = /^event: (\S+)\ndata: (.*)$/s.exec(block);
    (events[name] ??= []).push(JSON.parse(data));
  }
  return events;
}

// 公开插件目录里的一条记录：插件在仓库的子目录里，带一个 skill 和一个会运行代码的钩子。
const pluginCommit = "0123456789abcdef0123456789abcdef01234567";
const pluginFixture = {
  id: "plugin_fixture01",
  name: "Demo Tools",
  manifest_name: "demo-manifest",
  summary: "Demo plugin",
  release: { version: "1.2.3" },
  added_time: "2026-10-01T00:00:00Z",
  updated_time: "2026-11-01T00:00:00Z",
  source: {
    type: "directory",
    marketplace_slug: "anthropic-plugin-directory",
    repository: { url: "https://github.com/acme/tools", reviewed_commit: pluginCommit, path: "plugins/demo" },
  },
  components: [
    { type: "skill", name: "demo-skill", description: "Does the demo", access: { type: "stays_inside_claude" } },
    { type: "hook", name: "SessionStart", access: { type: "runs_on_your_computer" } },
  ],
  installation: { state: "signed_out", actions: { sign_in: true } },
};
const pluginFiles = {
  "README.md": "repo readme",
  "plugins/demo/.claude-plugin/plugin.json": '{"name":"demo"}',
  "plugins/demo/skills/demo-skill/SKILL.md": "# demo skill",
  "plugins/other/notes.txt": "another plugin",
};

/** 不压缩的 zip：GitHub 源码包的样子，所有条目在 `<仓库>-<提交号>/` 下。 */
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const label = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(label.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(label.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, label, data);
    centrals.push(central, label);
    offset += 30 + label.length + data.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centrals.reduce((size, part) => size + part.length, 0), 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 读回不压缩的 zip：条目名 → 内容，按本地文件头找数据并核对校验和。 */
function storedZipEntries(zip) {
  const end = zip.length - 22;
  assert.equal(zip.readUInt32LE(end), 0x06054b50);
  const entries = {};
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < zip.readUInt16LE(end + 10); index++) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const localAt = zip.readUInt32LE(at + 42);
    assert.equal(zip.readUInt32LE(localAt), 0x04034b50);
    assert.equal(zip.toString("utf8", localAt + 30, localAt + 30 + zip.readUInt16LE(localAt + 26)), name);
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const data = zip.subarray(dataAt, dataAt + size);
    assert.equal(crc32(data), zip.readUInt32LE(at + 16));
    entries[name] = data.toString("utf8");
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return entries;
}
let streamFixture;
let streamFixtureReady;

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

async function response(req, body) {
  const result = new Promise((resolve, reject) => {
    req.on("error", reject);
    req.on("response", (res) => {
      const chunks = [];
      res.on("error", reject);
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
  });
  req.end(body);
  return result;
}

async function request(pathname, { host, body, type = "application/json", method = body === undefined ? "GET" : "POST", beforeBody } = {}) {
  const raw = body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body);
  const headers = raw === undefined ? {} : {
    "content-type": type,
    "content-length": Buffer.byteLength(raw),
  };
  const send = async (req) => {
    if (beforeBody) {
      req.setHeader("expect", "100-continue");
      const ready = once(req, "continue");
      req.flushHeaders();
      await ready;
      await beforeBody();
    }
    return response(req, raw);
  };
  if (!host) {
    return send(http.request({
      hostname: "127.0.0.1", port: proxyPort, path: pathname, method, headers,
    }));
  }
  const connect = http.request({
    hostname: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${host}:443`,
  });
  connect.end();
  const [res, socket, head] = await once(connect, "connect");
  assert.equal(res.statusCode, 200);
  assert.equal(head.length, 0);
  const secure = tls.connect({
    socket, servername: host, ca: fs.readFileSync(path.join(here, "ca/ca.pem")),
  });
  await once(secure, "secureConnect");
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => secure;
  try {
    return await send(https.request({
      hostname: host, path: pathname, method, headers, agent,
    }));
  } finally {
    agent.destroy();
  }
}

async function requestText(host, pathname, headers = {}) {
  const connect = http.request({
    hostname: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${host}:443`,
  });
  connect.end();
  const [res, socket, head] = await once(connect, "connect");
  assert.equal(res.statusCode, 200);
  assert.equal(head.length, 0);
  const secure = tls.connect({
    socket, servername: host, ca: fs.readFileSync(path.join(here, "ca/ca.pem")),
  });
  await once(secure, "secureConnect");
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => secure;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: host, path: pathname, method: "GET", headers: { ...headers, connection: "close" }, agent,
      });
      req.on("error", reject);
      req.on("response", (response) => {
        const chunks = [];
        response.on("error", reject);
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve({
          status: response.statusCode,
          headers: response.headers,
          bytes: Buffer.concat(chunks),
          body: Buffer.concat(chunks).toString("utf8"),
        }));
      });
      req.end();
    });
    return result;
  } finally {
    agent.destroy();
  }
}

function websocketAccept(key) {
  return crypto.createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function websocketTextFrame(text) {
  const payload = Buffer.from(text);
  assert.ok(payload.length < 126);
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

function websocketCloseFrame(code = 1000) {
  return Buffer.from([0x88, 0x02, (code >> 8) & 0xff, code & 0xff]);
}

function websocketClientFrame(payload) {
  const data = Buffer.from(payload);
  assert.ok(data.length < 126);
  const mask = crypto.randomBytes(4);
  const frame = Buffer.alloc(2 + mask.length + data.length);
  frame[0] = 0x82;
  frame[1] = 0x80 | data.length;
  mask.copy(frame, 2);
  for (let index = 0; index < data.length; index += 1) {
    frame[6 + index] = data[index] ^ mask[index % 4];
  }
  return frame;
}

async function openTlsUpgrade({
  host = "claude.ai",
  pathname = "/api/ws/speech_to_text/voice_stream",
  origin = "https://claude.ai",
  extraHeaders = {},
} = {}) {
  const connect = http.request({
    hostname: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${host}:443`,
  });
  connect.end();
  const [res, socket, head] = await once(connect, "connect");
  assert.equal(res.statusCode, 200);
  assert.equal(head.length, 0);
  const secure = tls.connect({
    socket, servername: host, ca: fs.readFileSync(path.join(here, "ca/ca.pem")),
  });
  await once(secure, "secureConnect");
  const key = crypto.randomBytes(16).toString("base64");
  const headers = {
    Host: host,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
    ...(origin ? { Origin: origin } : {}),
    ...extraHeaders,
  };
  const rawHeaders = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`).join("");
  const responseBytes = new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const timeout = setTimeout(() => reject(new Error("WebSocket upgrade timed out")), 5000);
    const onData = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.includes(Buffer.from("\r\n\r\n"))) {
        clearTimeout(timeout);
        secure.off("error", onError);
        secure.off("data", onData);
        resolve(bytes);
      }
    };
    const onError = (error) => {
      clearTimeout(timeout);
      secure.off("data", onData);
      reject(error);
    };
    secure.on("data", onData);
    secure.once("error", onError);
  });
  secure.write(`GET ${pathname} HTTP/1.1\r\n${rawHeaders}\r\n`);
  const response = await responseBytes;
  const headerEnd = response.indexOf(Buffer.from("\r\n\r\n")) + 4;
  return {
    secure,
    key,
    status: response.subarray(0, headerEnd).toString("latin1"),
    remainder: response.subarray(headerEnd),
  };
}

before(async () => {
  dictationStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-local-dictation-"));
  coworkPromptFile = path.join(dictationStateDir, "cowork-prompt.txt");
  fs.writeFileSync(coworkPromptFile, coworkPromptFixture, { mode: 0o600 });
  const stateFile = path.join(dictationStateDir, "conversation-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    conversations: [{
      uuid: "11111111-2222-4333-8444-555555555557",
      name: "Persisted legacy conversation",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      nextIndex: 1,
      leafMessageId: "11111111-2222-4333-8444-555555555558",
      turns: [],
      chat_messages: [{
        uuid: "11111111-2222-4333-8444-555555555558",
        sender: "human",
        text: "legacy",
        index: 0,
        created_at: "2026-01-01T00:00:00.000Z",
        parent_message_uuid: null,
        files: null,
        files_v2: null,
        attachments: [{ file_name: "legacy.txt" }],
        sync_sources: null,
      }],
    }],
    notifications: [],
  }));
  dictationCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-local-cache-"));
  const assetHost = "assets-proxy.anthropic.com";
  dictationAssetPath = "/claude-ai/v2/assets/v1/c342ae4ef-ROR3Yba4.js";
  const assetCacheKey = `${assetHost}${dictationAssetPath}`;
  const assetCacheName = crypto.createHash("sha1").update(assetCacheKey).digest("hex");
  const assetBody = Buffer.from('import{ph as e}from"./preload-helper-test.js";const D=125e3;const A=6e4;');
  fs.writeFileSync(path.join(dictationCacheDir, assetCacheName), assetBody, { mode: 0o600 });
  fs.writeFileSync(
    path.join(dictationCacheDir, `${assetCacheName}.json`),
    JSON.stringify({
      status: 200,
      headers: { "content-type": "text/javascript; charset=utf-8" },
      url: assetCacheKey,
    }),
    { mode: 0o600 },
  );
  for (const [index, asset] of startupAssets.entries()) {
    const cacheKey = asset.url.replace(/^https:\/\//, "");
    const cacheName = crypto.createHash("sha1").update(cacheKey).digest("hex");
    fs.writeFileSync(
      path.join(dictationCacheDir, cacheName),
      asset.patch(index === 0 ? recorderFixture : facadeFixture),
      { mode: 0o600 },
    );
    fs.writeFileSync(path.join(dictationCacheDir, `${cacheName}.json`), JSON.stringify({
      status: 200,
      headers: { "content-type": "text/javascript; charset=utf-8" },
      url: cacheKey,
    }), { mode: 0o600 });
  }
  dictationFixture = http.createServer();
  dictationFixture.on("upgrade", (req, socket, head) => {
    dictationUpgrade = {
      path: req.url,
      token: req.headers["x-codex-plus-dictation-token"],
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
      host: req.headers.host,
    };
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${websocketAccept(req.headers["sec-websocket-key"])}\r\n\r\n`,
    );
    if (head.length) socket.write(head);
    let replied = false;
    socket.on("data", (chunk) => {
      dictationFrame = Buffer.concat([dictationFrame || Buffer.alloc(0), chunk]);
      if (!replied) {
        replied = true;
        socket.end(Buffer.concat([websocketTextFrame("helper-ok"), websocketCloseFrame()]));
      }
    });
  });
  dictationFixturePort = await listen(dictationFixture);
  fs.writeFileSync(
    path.join(dictationStateDir, "dictation-helper.json"),
    JSON.stringify({ port: dictationFixturePort, token: "123e4567-e89b-42d3-a456-426614174000" }),
    { mode: 0o600 },
  );

  gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    gatewayRequests.push({
      path: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/v1/messages/count_tokens") {
      res.end(JSON.stringify({ input_tokens: 123, context_management: null }));
      return;
    }
    res.end(JSON.stringify({ type: "message", content: [{ type: "text", text: "ok" }] }));
  });
  const gatewayPort = await listen(gateway);
  // 假上游：记录代理转发过来的 host 头与路径
  upstreamFixture = http.createServer((req, res) => {
    if (["mcp.demo.example", "mcp.auth.example", "auth.example"].includes(req.headers.host)) return connectorFixture(req, res);
    upstreamRequests.push({ host: req.headers.host, url: req.url });
    if (req.url === "/upstream-failure-fixture") return req.socket.destroy();
    if (req.url.startsWith("/stream-fixture/")) {
      // 先发一段就停住，等测试放行才发完：本地服务必须边收边转，不能等整包到齐。
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": streamFixtureSize });
      res.write(Buffer.alloc(streamFixtureSize / 2, 1));
      streamFixture = { res, closed: once(res, "close") };
      streamFixtureReady?.();
      return;
    }
    if (req.url === cdnAssetPath) {
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "content-encoding": "gzip",
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=31536000, immutable",
        connection: "close, x-fixture-hop",
        "x-fixture-hop": "remove-me",
      });
      return res.end(cdnAssetBody);
    }
    if (req.url === `/acme/tools/zip/${pluginCommit}`) {
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(storedZip(Object.fromEntries(
        Object.entries(pluginFiles).map(([name, content]) => [`tools-${pluginCommit}/${name}`, content]),
      )));
    }
    if (req.url === `/api/directory/plugins/${pluginFixture.id}`) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(pluginFixture));
    }
    if (req.url.startsWith("/api/directory/plugins/")) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    if (req.url.startsWith("/api/directory/plugins?") && decodeURIComponent(req.url).includes("manifest_name == 'demo-manifest'")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [pluginFixture], next_page: null, facets: {}, omitted: [] }));
    }
    if (req.url.startsWith("/api/directory/plugins")) {
      if (req.url.includes("refuse=1")) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: "region" }));
      }
      // 真接口自己带 CORS 头；这里故意不带，代理必须补上。
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "plugin_fixture" }], next_page: null, facets: {}, omitted: [] }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, host: req.headers.host, url: req.url }));
  });
  upstreamFixturePort = await listen(upstreamFixture);
  const reservation = net.createServer();
  proxyPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  proxy = spawn(process.execPath, [
    path.join(here, "proxy.mjs"), "--port", String(proxyPort), "--mode", "mock", "--log", "0",
  ], {
    env: {
      ...process.env,
      CLAUDE_LOCAL_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`,
      CLAUDE_LOCAL_UPSTREAM_MAP: JSON.stringify({
        "downloads.claude.ai": `http://127.0.0.1:${upstreamFixturePort}`,
        "assets-proxy.anthropic.com": `http://127.0.0.1:${upstreamFixturePort}`,
        "api.anthropic.com": `http://127.0.0.1:${upstreamFixturePort}`,
        "codeload.github.com": `http://127.0.0.1:${upstreamFixturePort}`,
        "mcp.demo.example": `http://127.0.0.1:${upstreamFixturePort}`,
        "mcp.auth.example": `http://127.0.0.1:${upstreamFixturePort}`,
        "auth.example": `http://127.0.0.1:${upstreamFixturePort}`,
      }),
      CLAUDE_LOCAL_CACHE_DIR: dictationCacheDir,
      CLAUDE_LOCAL_COWORK_PROMPT_FILE: coworkPromptFile,
      CLAUDE_LOCAL_STATE_FILE: path.join(dictationStateDir, "conversation-state.json"),
      CODEX_PLUS_STATE_DIR: dictationStateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proxyClosed = new Promise((resolve) => proxy.once("close", resolve));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Proxy did not start")), 10000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    proxy.once("error", fail);
    proxy.once("exit", (code) => fail(new Error(`Proxy exited with ${code}`)));
    proxy.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("claude-local proxy:")) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  if (proxy?.pid && proxy.exitCode === null && proxy.signalCode === null) {
    proxy.kill("SIGTERM");
  }
  if (proxyClosed) await proxyClosed;
  if (upstreamFixture) {
    upstreamFixture.closeAllConnections();
    await new Promise((resolve) => upstreamFixture.close(resolve));
  }
  if (gateway) await new Promise((resolve) => gateway.close(resolve));
  if (dictationFixture) await new Promise((resolve) => dictationFixture.close(resolve));
  if (coworkPromptFile) fs.unlinkSync(coworkPromptFile);
  if (dictationStateDir) {
    fs.unlinkSync(path.join(dictationStateDir, "dictation-helper.json"));
    fs.unlinkSync(path.join(dictationStateDir, "conversation-state.json"));
    fs.rmSync(path.join(dictationStateDir, "project-files"), { recursive: true, force: true });
    fs.rmdirSync(dictationStateDir);
  }
  if (dictationCacheDir) {
    for (const file of fs.readdirSync(dictationCacheDir)) {
      fs.unlinkSync(path.join(dictationCacheDir, file));
    }
    fs.rmdirSync(dictationCacheDir);
  }
});

test("mock mode serves the patched dictation module with the CDN cross-origin contract", async () => {
  const result = await requestText("assets-proxy.anthropic.com", dictationAssetPath, {
    origin: "https://claude.ai",
  });
  assert.equal(result.status, 200);
  assert.equal(result.headers["access-control-allow-origin"], "*");
  assert.match(result.headers["content-type"], /^text\/javascript\b/);
  assert.equal(result.headers["cache-control"], "no-store");
  assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
  assert.match(result.body, /D=125e3/);
  assert.doesNotMatch(result.body, /D=2e3/);
});

for (const asset of startupAssets) {
  test(`mock mode preserves CORS and exact startup patch for ${asset.name}`, async () => {
    const result = await requestText("assets-proxy.anthropic.com", asset.pathname, {
      origin: "https://claude.ai",
    });
    assert.equal(result.status, 200);
    assert.equal(result.headers["access-control-allow-origin"], "*");
    assert.match(result.headers["content-type"], /^text\/javascript\b/);
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(Number(result.headers["content-length"]), Buffer.byteLength(result.body));
    assert.deepEqual(asset.patch(result.body), Buffer.from(result.body));
    assert.match(result.body, /codex-local-dictation-start-v1/);
  });
}

test("Claude dictation websocket is authorized locally and forwards only bounded metadata", async () => {
  const clientFrame = websocketClientFrame("synthetic-pcm-frame");
  const result = await openTlsUpgrade({
    pathname: "/api/ws/speech_to_text/voice_stream?language=zh&stt_provider=deepgram-nova3&organization_uuid=private",
    extraHeaders: { Cookie: "session=private", Authorization: "Bearer private" },
  });
  assert.match(result.status, /^HTTP\/1\.1 101 /);
  assert.equal(result.status.includes("123e4567-e89b-42d3-a456-426614174000"), false);
  assert.deepEqual(dictationUpgrade, {
    path: "/dictation/claude-stream?language=zh",
    token: "123e4567-e89b-42d3-a456-426614174000",
    cookie: undefined,
    authorization: undefined,
    host: `127.0.0.1:${dictationFixturePort}`,
  });
  dictationFrame = undefined;
  const clientResponse = new Promise((resolve, reject) => {
    let bytes = result.remainder;
    const timeout = setTimeout(() => reject(new Error("helper response did not close cleanly")), 3000);
    const onData = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
    };
    const onClose = () => {
      clearTimeout(timeout);
      result.secure.off("error", onError);
      result.secure.off("data", onData);
      resolve(bytes);
    };
    const onError = (error) => {
      clearTimeout(timeout);
      result.secure.off("data", onData);
      result.secure.off("close", onClose);
      reject(error);
    };
    result.secure.on("data", onData);
    result.secure.once("error", onError);
    result.secure.once("close", onClose);
  });
  result.secure.write(clientFrame);
  const responseBytes = await clientResponse;
  assert.ok(dictationFrame.includes(clientFrame));
  assert.ok(responseBytes.includes(websocketTextFrame("helper-ok")));
  assert.ok(responseBytes.includes(websocketCloseFrame()));
});

test("Claude dictation websocket rejects untrusted origins before reaching the helper", async () => {
  const previous = dictationUpgrade;
  const result = await openTlsUpgrade({ origin: "https://attacker.example" });
  assert.match(result.status, /^HTTP\/1\.1 403 /);
  assert.equal(dictationUpgrade, previous);
  result.secure.destroy();
});

for (const host of [undefined, "api.anthropic.com", "claude.ai"]) {
  test(`managed settings satisfy the CLI response contract over ${host || "direct HTTP"}`, async () => {
    const result = await request("/api/claude_code/settings", { host });
    assert.equal(result.status, 200);
    // Claude Code 2.1.317 requires all three fields; Desktop only checks settings.
    assert.equal(typeof result.body.uuid, "string");
    assert.notEqual(result.body.uuid, "");
    assert.equal(typeof result.body.checksum, "string");
    assert.deepEqual(result.body.settings, {});
    assert.equal(result.headers.etag, JSON.stringify(result.body.checksum));
    const again = await request("/api/claude_code/settings", { host });
    assert.equal(again.body.uuid, result.body.uuid);
  });
}

test("Code user settings keep the Desktop content.entries shape", async () => {
  const result = await request("/api/claude_code/organizations/local/user_settings", { host: "claude.ai" });
  assert.deepEqual(result.body.content.entries, {});
});

test("Code settings receive a top-level list of connected instances", async () => {
  const result = await request("/api/oauth/organizations/local/oauth_tokens?application_slug=claude-code", {
    host: "claude.ai",
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, []);
});

test("Cowork plugin metadata is a dictionary rather than a paginated list", async () => {
  const result = await request("/api/organizations/local/cowork_plugin_metadata", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {});
});

test("memory settings and memory edits answer in the shapes the settings page validates", async () => {
  const settings = "/api/organizations/local/memory/settings";
  const off = await request(settings, { host: "claude.ai", body: { enabled_melange: false, enabled_saffron: false } });
  assert.equal(off.status, 200);
  assert.equal(off.body.memory_mode, "off");
  assert.equal(off.body.enabled_saffron, false);
  assert.equal((await request(settings, { host: "claude.ai" })).body.memory_mode, "off");
  const classic = await request(settings, { host: "claude.ai", body: { enabled_melange: false, enabled_saffron: true } });
  assert.equal(classic.body.memory_mode, "classic");

  const memory = await request("/api/organizations/local/memory?project_uuid=p1", { host: "claude.ai" });
  assert.equal(memory.status, 200);
  assert.equal(typeof memory.body.memory, "string");
  assert.ok("controls" in memory.body && "updated_at" in memory.body);

  const saved = await request("/api/organizations/local/memory/controls", {
    host: "claude.ai", method: "PUT", body: { controls: ["喜欢简短的回答"], base_controls_version: null },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.controls, ["喜欢简短的回答"]);
  assert.equal(typeof saved.body.controls_version, "string");
  assert.ok(!Number.isNaN(Date.parse(saved.body.updated_at)));
  assert.deepEqual((await request("/api/organizations/local/memory", { host: "claude.ai" })).body.controls, ["喜欢简短的回答"]);

  const reset = await request("/api/organizations/local/memory/reset", { host: "claude.ai", body: {} });
  assert.equal(reset.body.controls, null);
});

test("project conversation lists are pages rather than empty objects", async () => {
  const result = await request("/api/organizations/local/projects/p1/conversations_v2?limit=30&offset=0", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.data, []);
  assert.equal(result.body.pagination.has_more, false);
});

/** 一个文件字段的 multipart/form-data 请求体。 */
function formFile(filename, type, data) {
  const boundary = `----fixture${crypto.randomUUID()}`;
  return {
    type: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
      Buffer.from(data),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("document conversion extracts text from Office files and plain text, and refuses what it cannot read", async () => {
  const convert = (filename, type, data) => request("/api/organizations/local/convert_document", { host: "claude.ai", ...formFile(filename, type, data) });
  const docx = storedZip({
    "word/document.xml": '<w:document><w:body><w:p><w:r><w:t>第一段 &amp; more</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/><w:t>tab</w:t></w:r></w:p></w:body></w:document>',
  });
  const converted = await convert("报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx);
  assert.equal(converted.status, 200);
  assert.equal(converted.body.file_name, "报告.docx");
  assert.equal(converted.body.extracted_content, "第一段 & more\nSecond\ttab");

  const xlsx = storedZip({
    "xl/sharedStrings.xml": "<sst><si><t>名称</t></si><si><t>数量</t></si></sst>",
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row><row><c t="inlineStr"><is><t>苹果</t></is></c><c><v>3</v></c></row></sheetData></worksheet>',
  });
  assert.equal((await convert("表.xlsx", "application/octet-stream", xlsx)).body.extracted_content, "## Sheet 1\n名称\t数量\n苹果\t3");

  const pptx = storedZip({ "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>标题</a:t></a:r></a:p></p:sld>" });
  assert.equal((await convert("演示.pptx", "application/octet-stream", pptx)).body.extracted_content, "## Slide 1\n标题");

  assert.equal((await convert("notes.md", "text/markdown", "# 标题\n正文")).body.extracted_content, "# 标题\n正文");
  const pdf = await convert("scan.pdf", "application/pdf", "%PDF-1.7\n...");
  assert.equal(pdf.status, 422);
  assert.equal(pdf.body.error.details.error_code, "extraction_failed");
});

test("project uploads keep images and PDFs as files and refuse other files", async () => {
  const org = "/api/organizations/local";
  const project = (await request(`${org}/projects`, { host: "claude.ai", body: { name: "Uploads" } })).body;
  const upload = (filename, type, data) => request(`${org}/projects/${project.uuid}/upload`, { host: "claude.ai", ...formFile(filename, type, data) });

  const pdf = await upload("spec.pdf", "application/pdf", "%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n3 0 obj << /Type /Pages >> endobj");
  assert.equal(pdf.status, 200);
  assert.equal(pdf.body.file_kind, "document");
  assert.equal(pdf.body.document_asset.page_count, 2);
  assert.equal(pdf.body.document_asset.url, `/api/local/files/${pdf.body.file_uuid}/document`);
  // 客户端把 Office 文档送去转文本、纯文本自己读，别的文件传到这里一律不收。
  const text = await upload("notes.txt", "text/plain", "plain knowledge");
  assert.equal(text.status, 400);
  assert.equal(text.body.error.details.error_code, "invalid_file_type");

  const files = (await request(`${org}/projects/${project.uuid}/files`, { host: "claude.ai" })).body;
  assert.deepEqual(files.map((file) => file.file_name), ["spec.pdf"]);
  assert.deepEqual((await request(`${org}/projects/${project.uuid}/docs`, { host: "claude.ai" })).body, []);

  const removed = await request(`${org}/projects/${project.uuid}/files/delete_many`, { host: "claude.ai", body: { file_uuids: [pdf.body.file_uuid] } });
  assert.equal(removed.status, 200);
  assert.deepEqual((await request(`${org}/projects/${project.uuid}/files`, { host: "claude.ai" })).body, []);
});

test("local mock accounts do not request identity verification", async () => {
  const result = await request("/api/organizations/local/kyc_status", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { status: "not_required", should_poll: false });
});

test("Desktop receives the native Computer Use rollout without enabling permissions", async () => {
  const result = await request("/api/desktop/features", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.equal(result.body.features["1291166712"].value.enabled, true);
  assert.equal(result.body.features["1291166712"].on, true);
  assert.equal(result.body.features["1291166712"].off, false);
  assert.equal(result.body.features["1291166712"].source, "force");
  // Windows 上计算机使用还要过 40173473 这道门，否则设置页说「账户尚未启用」。
  assert.equal(result.body.features["40173473"].value, true);
  assert.equal(result.body.features["40173473"].on, true);
  assert.equal(result.body.features["40173473"].off, false);
  // 2340532315：账号插件的同步；600735300：连接器登录在应用内完成。
  assert.deepEqual(Object.keys(result.body.features).sort(), ["1291166712", "2340532315", "40173473", "600735300"]);
  assert.equal(result.body.chicagoEnabled, undefined);
});

test("Desktop exposes the separate background-mode capability without selecting a user mode", async () => {
  const result = await request("/api/desktop/features", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.features["1291166712"].value, {
    enabled: true, appScopedEnabled: true,
  });
  assert.equal(result.body.chicagoPreferredMode, undefined);
});

test("mock mode serves the cowork system prompt through the bootstrap and its own endpoint", async () => {
  const endpoint = await request("/api/bootstrap/00000000-0000-4000-8000-636c61756465/system_prompts", { host: "claude.ai" });
  assert.equal(endpoint.status, 200);
  assert.equal(endpoint.body.cowork_system_prompt.value.prompt, coworkPromptFixture);
  assert.equal(endpoint.body.cowork_system_prompt.source, "defaultValue");

  const bootstrap = await request("/api/bootstrap", { host: "claude.ai" });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.system_prompts.cowork_system_prompt.value.prompt, coworkPromptFixture);
});

test("Desktop keeps its own macOS ceiling for background mode unless forced", async () => {
  const result = await request("/api/desktop/features", { host: "claude.ai" });
  assert.equal(result.body.features["1346958739"], undefined);
});

test("account settings receive deletion eligibility and trusted-device lists", async () => {
  const eligibility = await request("/api/account/deletion-allowed", { host: "claude.ai" });
  assert.equal(eligibility.status, 200);
  assert.equal(eligibility.body.deletable, false);
  assert.deepEqual(eligibility.body.reasons, []);
  const devices = await request("/api/auth/trusted_devices", { host: "claude.ai" });
  assert.deepEqual(devices.body.devices, []);
});

test("account security receives an explicit list of local MFA methods", async () => {
  const result = await request("/api/auth/mfa", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.methods, []);
  assert.equal(result.body.methods.find((entry) => entry.method === "sms"), undefined);
  assert.equal(result.body.mfa_enrolled, false);
});

test("account sessions receive a valid empty paginated response", async () => {
  const result = await request("/api/auth/sessions/list-active", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { data: [], pagination: { has_more: false, total: 0 } });
});

test("billing settings receive an empty invoice page without undefined rows", async () => {
  const result = await request("/api/stripe/local/invoices?limit=12&page=", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { invoices: [], next_page: null });
  assert.deepEqual([result.body].flatMap((page) => page.invoices), []);
});

test("Artifacts receives a concrete artifact list and count", async () => {
  const result = await request("/api/organizations/local/user_artifacts?limit=30&offset=0&include_latest_published_artifact_uuid=true", {
    host: "claude.ai",
  });
  assert.equal(result.status, 200);
  assert.deepEqual([...result.body.artifacts], []);
  const count = await request("/api/organizations/local/user_artifacts/count", { host: "claude.ai" });
  assert.equal(count.body.count, 0);
});

test("Artifacts shared galleries receive frame arrays instead of load-error states", async () => {
  for (const endpoint of ["/api/frame/frames", "/api/frame/frames/external"]) {
    const result = await request(endpoint, { host: "claude.ai" });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.frames, []);
  }
});

test("general settings can read and update notification preferences without losing other channels", async () => {
  const endpoint = "/api/organizations/notification-test/notification/preferences";
  const initial = await request(endpoint, { host: "claude.ai" });
  assert.deepEqual(initial.body.preferences.feature_preference, {});
  assert.deepEqual(initial.body.effective_preferences, {});
  const patch = (feature_preference) => request(endpoint, {
    host: "claude.ai", method: "PATCH", body: { preferences: { feature_preference } },
  });
  await patch({ completion: { enable_push: true }, compass: { enable_push: true } });
  await patch({ completion: { enable_email: true } });
  const updated = await patch({ completion: { enable_push: false } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.preferences.feature_preference, {
    completion: { enable_push: false, enable_email: true }, compass: { enable_push: true },
  });
  assert.deepEqual(updated.body.effective_preferences.completion, {
    enable_push: false, push_source: "explicit", enable_email: true, email_source: "explicit",
  });
  const again = await request(endpoint, { host: "claude.ai" });
  assert.deepEqual(again.body, updated.body);
  const other = await request("/api/organizations/other/notification/preferences", { host: "claude.ai" });
  assert.deepEqual(other.body.preferences.feature_preference, {});
});

test("concurrent first notification updates preserve both features", async () => {
  const endpoint = "/api/organizations/concurrent-notifications/notification/preferences";
  // 先确认服务端已接收首请求，再让第二个 PATCH 抢先完成。
  await request(endpoint, {
    host: "claude.ai", method: "PATCH",
    body: { preferences: { feature_preference: { completion: { enable_push: true } } } },
    beforeBody: () => request(endpoint, {
      host: "claude.ai", method: "PATCH",
      body: { preferences: { feature_preference: { compass: { enable_email: true } } } },
    }),
  });
  const result = await request(endpoint, { host: "claude.ai" });
  assert.deepEqual(result.body.preferences.feature_preference, {
    completion: { enable_push: true }, compass: { enable_email: true },
  });
});

test("notification updates reject malformed envelopes and preserve safe dictionaries", async () => {
  const endpoint = "/api/organizations/notification-validation/notification/preferences";
  const invalid = await request(endpoint, { host: "claude.ai", method: "PATCH", body: { preferences: { feature_preference: [] } } });
  assert.equal(invalid.status, 400);
  const result = await request(endpoint, {
    host: "claude.ai", method: "PATCH",
    body: { preferences: { feature_preference: {
      ["__proto__"]: { enable_push: true },
      constructor: { enable_email: false },
      completion: { enable_push: "true", enable_email: false },
    } } },
  });
  assert.deepEqual(result.body.preferences.feature_preference.completion, { enable_email: false });
  assert.deepEqual(result.body.preferences.feature_preference.__proto__, { enable_push: true });
  const clean = await request("/api/organizations/notification-clean/notification/preferences", { host: "claude.ai" });
  assert.deepEqual(clean.body.preferences.feature_preference, {});
});

test("Chinese web catalogs cover Code settings with both long and short message IDs", async () => {
  const result = await request("/i18n/s/zh-Hans.json?v=local-test", { host: "claude.ai" });
  assert.equal(result.status, 200);
  assert.equal(result.body.mnLinrjnq9, "没有已连接的 Claude Code 实例");
  assert.equal(result.body.mnLinr, result.body.mnLinrjnq9);
  assert.equal(result.body.jqhhMI, "设置");
  assert.equal(result.body.iTM1PGTIqQ, "授权令牌");
  assert.ok(Object.keys(result.body).length > 30000);
});

test("Chinese full catalogs preserve navigation translations under long message IDs", async () => {
  const result = await request("/i18n/zh-Hans.json", { host: "claude.ai" });
  assert.equal(result.body.jqhhMImrPt, "设置");
  assert.equal(result.body.y1Z3orIe9Z, "语言");
});

test("dynamic catalogs contain dynamic translations rather than Desktop shell messages", async () => {
  const result = await request("/i18n/dynamic/zh-Hans.json", { host: "claude.ai" });
  assert.equal(result.body["0gtp5o1nEE"], "复杂、细致的工作");
  assert.equal(result.body["+/cwsayrqk"], undefined);
});

test("token counting uses the configured gateway's result", async () => {
  const before = gatewayRequests.length;
  const body = { model: "local-model", messages: [{ role: "user", content: "hello" }] };
  const result = await request("/v1/messages/count_tokens", {
    body,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { input_tokens: 123, context_management: null });
  assert.equal(gatewayRequests.length, before + 1);
  assert.deepEqual(gatewayRequests.at(-1), { path: "/v1/messages/count_tokens", body });
});

test("upstream requests keep their original host instead of being rewritten to claude.ai", async () => {
  const result = await request("/claude-code-releases/2.1.317/darwin-arm64/claude.app.tar.zst", {
    host: "downloads.claude.ai",
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  const seen = upstreamRequests.at(-1);
  assert.equal(seen.host, "downloads.claude.ai");
  assert.equal(seen.url, "/claude-code-releases/2.1.317/darwin-arm64/claude.app.tar.zst");
});

test("only the Desktop web origins can read the proxy's upstream failures across origins", async () => {
  for (const [origin, allowed] of [["https://claude.ai", true], ["https://claude.com", true],
    ["https://example.org", false], ["https://claude.ai.example.org", false], ["null", false], [undefined, false]]) {
    const failure = await requestText("assets-proxy.anthropic.com", "/upstream-failure-fixture", origin ? { origin } : {});
    assert.equal(failure.status, 502);
    assert.equal(failure.headers["access-control-allow-origin"], allowed ? origin : undefined);
    assert.equal(failure.headers["access-control-allow-credentials"], allowed ? "true" : undefined);
    assert.equal(failure.headers.vary.toLowerCase(), "origin");
    assert.equal(failure.headers["cache-control"], "no-store");
    assert.match(failure.body, /upstream unavailable/);
  }
});

async function openDownload(host, pathname) {
  const connect = http.request({
    hostname: "127.0.0.1", port: proxyPort, method: "CONNECT", path: `${host}:443`,
  });
  connect.end();
  const [, socket] = await once(connect, "connect");
  const secure = tls.connect({ socket, servername: host, ca: fs.readFileSync(path.join(here, "ca/ca.pem")) });
  await once(secure, "secureConnect");
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => secure;
  const req = https.request({ hostname: host, path: pathname, method: "GET", agent });
  req.end();
  const [res] = await once(req, "response");
  return { req, res, secure };
}

test("large downloads are forwarded while they arrive instead of after the whole body", async () => {
  const ready = new Promise((resolve) => { streamFixtureReady = resolve; });
  const { res, secure } = await openDownload("downloads.claude.ai", "/stream-fixture/claude.zip");
  await ready;
  assert.equal(res.statusCode, 200);
  assert.equal(Number(res.headers["content-length"]), streamFixtureSize);
  let received = 0;
  res.on("data", (chunk) => { received += chunk.length; });
  // 上游还没发完，Claude 这边就已经收到前一半了（以前要等整包，下载器先空闲超时）。
  const deadline = Date.now() + 5000;
  while (received < streamFixtureSize / 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(received, streamFixtureSize / 2);
  streamFixture.res.end(Buffer.alloc(streamFixtureSize / 2, 2));
  await once(res, "end");
  assert.equal(received, streamFixtureSize);
  secure.destroy();
});

test("abandoning a forwarded download closes the upstream request", async () => {
  const ready = new Promise((resolve) => { streamFixtureReady = resolve; });
  const { res, secure } = await openDownload("downloads.claude.ai", "/stream-fixture/abandoned.zip");
  await ready;
  await once(res, "data");
  secure.destroy();
  await Promise.race([
    streamFixture.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("upstream download left open")), 5000)),
  ]);
});

test("hashed CDN assets replay cached compressed bytes before contacting the upstream", async () => {
  const before = upstreamRequests.length;
  const first = await requestText("assets-proxy.anthropic.com", cdnAssetPath);
  assert.equal(upstreamRequests.length, before + 1);
  const second = await requestText("assets-proxy.anthropic.com", cdnAssetPath);
  assert.equal(upstreamRequests.length, before + 1, "cached CDN module must not wait for upstream or its timeout");
  for (const result of [first, second]) {
    assert.equal(result.status, 200);
    assert.deepEqual(result.bytes, cdnAssetBody);
    assert.equal(result.headers["content-encoding"], "gzip");
    assert.equal(result.headers["access-control-allow-origin"], "*");
    assert.equal(result.headers["transfer-encoding"], undefined);
    assert.equal(result.headers["x-fixture-hop"], undefined);
    assert.equal(Number(result.headers["content-length"]), cdnAssetBody.length);
    assert.equal(gunzipSync(result.bytes).toString("utf8"), 'export const fixture = "cached CDN bytes";');
  }
});

test("CDN dynamic APIs ignore old cache entries and do not persist responses", async () => {
  const dynamicPath = "/api/usage";
  const key = `assets-proxy.anthropic.com${dynamicPath}`;
  const cached = path.join(dictationCacheDir, crypto.createHash("sha1").update(key).digest("hex"));
  const oldBody = JSON.stringify({ stalePrivateFixture: true });
  fs.writeFileSync(cached, oldBody);
  fs.writeFileSync(`${cached}.json`, JSON.stringify({ status: 200, headers: { "content-type": "application/json" }, url: key }));
  const before = upstreamRequests.length;
  const first = await requestText("assets-proxy.anthropic.com", dynamicPath);
  const second = await requestText("assets-proxy.anthropic.com", dynamicPath);
  assert.equal(upstreamRequests.length, before + 2);
  assert.equal(JSON.parse(first.body).ok, true);
  assert.equal(JSON.parse(second.body).stalePrivateFixture, undefined);
  assert.equal(fs.readFileSync(cached, "utf8"), oldBody);

  const uncachedPath = "/api/model_metadata";
  await requestText("assets-proxy.anthropic.com", uncachedPath);
  const uncachedKey = crypto.createHash("sha1").update(`assets-proxy.anthropic.com${uncachedPath}`).digest("hex");
  assert.equal(fs.existsSync(path.join(dictationCacheDir, uncachedKey)), false);
  assert.equal(fs.existsSync(path.join(dictationCacheDir, `${uncachedKey}.json`)), false);
});

test("model requests keep diagnostics by default", async () => {
  const payload = {
    model: "local-model",
    messages: [{ role: "user", content: "hello" }],
    diagnostics: { source: "desktop" },
    metadata: { user_id: "local-test", diagnostics: {} },
    max_tokens: 16,
  };
  const result = await request("/v1/messages?beta=true", {
    body: payload,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(gatewayRequests.at(-1), { path: "/v1/messages?beta=true", body: payload });
});

test("legacy persisted messages with null array fields are normalized before returning to the desktop", async () => {
  const result = await request(
    "/api/organizations/local/chat_conversations/11111111-2222-4333-8444-555555555557",
    { host: "claude.ai" },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.chat_messages[0].files, []);
  assert.deepEqual(result.body.chat_messages[0].files_v2, []);
  assert.deepEqual(result.body.chat_messages[0].attachments, [{ file_name: "legacy.txt" }]);
  assert.deepEqual(result.body.chat_messages[0].sync_sources, []);
});

test("plugin installed-check returns its checked-list contract", async () => {
  const result = await request("/api/organizations/local/library/plugins/installed_check", {
    host: "claude.ai",
    body: { sync: "desktop_plugins", plugins: [{ id: "example", name: "Example" }] },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { checked: [] });
});

test("unknown remote plugin details return the API not-found contract", async () => {
  for (const pathname of [
    "/api/organizations/local/plugins/example-plugin",
    "/api/organizations/local/plugins/plugin_unknown01",
    "/api/organizations/local/plugins/by-name/example-plugin?marketplace_name=official",
    "/api/organizations/local/plugins/by-name/example-plugin?marketplace_name=anthropic-plugin-directory",
  ]) {
    const result = await request(pathname, { host: "claude.ai" });
    assert.equal(result.status, 404);
    assert.equal(result.body.error.details.error_code, "plugin_not_found");
  }
});

test("plugins install from the public directory: detail, enable, download, listed, remove", async () => {
  const org = "/api/organizations/local";
  const get = (pathname) => request(`${org}/${pathname}`, { host: "claude.ai" });

  // 详情页先在默认市场里按名字找到目录，再带着它的 id 按名字读插件。
  const marketplace = (await get("marketplaces/list-default-marketplaces")).body.marketplaces
    .find((entry) => entry.name === "anthropic-plugin-directory");
  assert.equal(marketplace.is_default, true);
  const byName = await get(`plugins/by-name/demo-manifest?marketplace_name=${marketplace.name}&marketplace_id=${marketplace.id}&partition_by=organization`);
  assert.equal(byName.status, 200);
  assert.equal(byName.body.id, pluginFixture.id);
  assert.equal(byName.body.name, "demo-manifest", "前端要求 name 等于地址里的名字");
  assert.equal(byName.body.marketplace_id, marketplace.id, "前端要求 marketplace_id 等于市场 id");
  assert.deepEqual(byName.body.mcp_servers, {});
  assert.equal(byName.body.display_name, "Demo Tools");
  assert.equal(byName.body.enabled, false);
  assert.equal(byName.body.installation_preference, "available");
  assert.equal(byName.body.reach, "privileged", "带钩子的插件安装前要提示会在电脑上运行代码");
  assert.deepEqual(byName.body.skills, [{ name: "demo-skill", description: "Does the demo", user_invocable: true }]);
  assert.deepEqual(byName.body.hooks, [{ event: "SessionStart", matchers: [] }]);
  assert.equal((await get(`plugins/${pluginFixture.id}`)).body.id, pluginFixture.id);
  assert.deepEqual((await get(`plugins/${pluginFixture.id}/scan-status`)).body, { content_scan: null });
  assert.equal((await get(`plugins/${pluginFixture.id}/versions?page_size=100`)).status, 404);

  const enabledList = () => get("plugins/list-plugins?enabled_only=true&compact=true&limit=100&offset=0");
  assert.deepEqual((await enabledList()).body, { plugins: [], has_more: false });

  // 「添加」：网页 PUT enabled，桌面端随后读这三个接口来下载和挂载。
  const enabled = await request(`${org}/plugins/${pluginFixture.id}/enabled`, {
    host: "claude.ai", method: "PUT", body: { enabled: true, install_source: "browse" },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.ok(Array.isArray(enabled.body.skills));
  const [row] = (await enabledList()).body.plugins;
  assert.equal(row.id, pluginFixture.id);
  assert.equal(row.name, "demo-manifest");
  assert.equal(row.marketplace_name, "anthropic-plugin-directory", "缺了市场名，桌面端会丢掉这一行");
  assert.equal(row.updated_at, pluginFixture.updated_time);
  assert.deepEqual((await get("plugins/enabled-state")).body.preferences, [{
    plugin_name: "demo-manifest", marketplace_id: marketplace.id, marketplace_name: marketplace.name, enabled: true,
  }]);
  // 组织强制安装的那种查法始终是空的，否则桌面端会把它当成管理员下发的插件。
  assert.deepEqual((await get("plugins/list-plugins?installation_preference=auto_install&installation_preference=required&limit=100&offset=0")).body.plugins, []);
  const mine = (await get("library/mine?kind=plugin&limit=1000")).body.items;
  assert.equal(mine[0].plugin.backend_id, pluginFixture.id);
  assert.equal(mine[0].viewer.installed.enabled, true);
  const yours = (await get(`directory/plugins?filter=${encodeURIComponent("installation.state in ['enabled', 'disabled']")}&limit=1000`)).body.data;
  assert.equal(yours[0].id, pluginFixture.id);
  assert.equal(yours[0].installation.state, "enabled");

  // 安装包：仓库在审核过的提交上的源码，只留插件所在的子目录。
  const zip = await requestText("claude.ai", `${org}/plugins/${pluginFixture.id}/download`);
  assert.equal(zip.status, 200);
  assert.deepEqual(storedZipEntries(zip.bytes), {
    ".claude-plugin/plugin.json": '{"name":"demo"}',
    "skills/demo-skill/SKILL.md": "# demo skill",
  });
  assert.equal(upstreamRequests.some((seen) => seen.host === "codeload.github.com" && seen.url === `/acme/tools/zip/${pluginCommit}`), true);

  const removed = await request(`${org}/plugins/${pluginFixture.id}/enabled`, {
    host: "claude.ai", method: "PUT", body: { enabled: false, install_source: "remove" },
  });
  assert.equal(removed.body.enabled, false);
  assert.deepEqual((await enabledList()).body.plugins, []);
  assert.deepEqual((await get("plugins/enabled-state")).body.preferences, []);
});

test("a connector that needs no sign-in is added, shows as connected with its tools, runs them, and is removed", async () => {
  const mcp = "/api/organizations/local/mcp";
  const before = await connectorEvents();
  assert.deepEqual(before.server_list[0].servers, []);
  assert.ok(before.first_pass_complete && before.completed, "空名单也要明确结束，否则页面一直等");

  const created = await request(`${mcp}/remote_servers`, {
    host: "claude.ai",
    body: { name: "Demo", url: "https://mcp.demo.example/mcp", mcp_directory_server_uuid: "69f3a300-cc60-48c4-b237-dfac56530dbf", user_confirmed: true },
  });
  assert.equal(created.status, 200);
  const { uuid } = created.body;
  assert.match(uuid, /^[0-9a-f-]{36}$/);
  assert.equal(created.body.name, "Demo");
  assert.equal(created.body.url, "https://mcp.demo.example/mcp");
  assert.equal(created.body.mcp_directory_server_uuid, "69f3a300-cc60-48c4-b237-dfac56530dbf");
  assert.match(created.body.created_at, /Z$/);
  // 同一个地址再加一次：给回原来那条。
  const again = await request(`${mcp}/remote_servers`, { host: "claude.ai", body: { name: "Demo", url: "https://mcp.demo.example/mcp" } });
  assert.equal(again.body.uuid, uuid);
  assert.equal(again.body.existing, true);
  assert.equal((await request(`${mcp}/remote_servers`, { host: "claude.ai", body: { name: "Plain", url: "http://mcp.demo.example/mcp" } })).status, 400);

  // 页面加完连接器总会「连接」一次：不用登录的直接算连上。
  const started = await request(`${mcp}/start-auth/${uuid}?response_format=json&desktop_finish=claude`, { host: "claude.ai" });
  assert.deepEqual(started.body, { connected: true });

  const events = await connectorEvents();
  assert.deepEqual(events.server_list[0].servers, [{
    uuid, name: "Demo", url: "https://mcp.demo.example/mcp", directoryEntryUuid: "69f3a300-cc60-48c4-b237-dfac56530dbf",
  }]);
  const [base] = events.server_base;
  assert.equal(base.uuid, uuid);
  assert.equal(base.connected, true);
  assert.equal(base.authStatus, "not_required");
  assert.equal(base.usedAuthentication, false);
  assert.equal(base.instructions, "Use the echo tool.");
  assert.deepEqual(events.tools, [{
    server_uuid: uuid,
    tools: [{
      name: "echo", description: "Echoes", inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { title: "Echo" }, displayName: "Echo", enabled_key: `${uuid}:echo`, always_approved_key: `${uuid}:echo:always`,
    }],
  }]);
  assert.deepEqual(Object.keys(events), ["server_list", "server_base", "tools", "first_pass_complete", "completed"]);

  const listed = (await request(`${mcp}/remote_servers_with_connection`, { host: "claude.ai" })).body;
  assert.equal(listed[0].uuid, uuid);
  assert.equal(listed[0].connection_state, "connected");
  assert.equal(listed[0].connection_auth_type, null);
  assert.equal((await request(`${mcp}/remote_servers/${uuid}`, { host: "claude.ai" })).body.uuid, uuid);
  assert.equal((await request(`${mcp}/remote_servers`, { host: "claude.ai" })).body.length, 1);

  // 会话里调用工具：桌面端主进程发的就是这个请求。
  const called = await request(`${mcp}/servers/${uuid}/tools/call`, { host: "claude.ai", body: { tool_name: "echo", arguments: { text: "hi" } } });
  assert.equal(called.status, 200);
  assert.deepEqual(called.body, { content: [{ type: "text", text: "echo: hi" }], is_error: false, structured_content: { ok: true } });
  assert.deepEqual(mcpFixture.calls.at(-1), { host: "mcp.demo.example", authorization: undefined, params: { name: "echo", arguments: { text: "hi" } } });

  const gone = await request(`${mcp}/remote_servers/${uuid}`, { host: "claude.ai", method: "DELETE" });
  assert.equal(gone.status, 200);
  const after = await connectorEvents();
  assert.deepEqual(after.server_list[0].servers, []);
  assert.deepEqual(after.server_list[0].deleted_server_uuids, [uuid]);
  const missing = await request(`${mcp}/servers/${uuid}/tools/call`, { host: "claude.ai", body: { tool_name: "echo", arguments: {} } });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.details.error_code, "mcp_connector_removed");
});

test("a connector that needs sign-in goes through OAuth in the browser and hands the result back to the app", async () => {
  const mcp = "/api/organizations/local/mcp";
  const { uuid } = (await request(`${mcp}/remote_servers`, { host: "claude.ai", body: { name: "Private", url: "https://mcp.auth.example/mcp" } })).body;

  const waiting = await connectorEvents();
  assert.equal(waiting.server_base[0].connected, false);
  assert.equal(waiting.server_base[0].authStatus, "auth_required");
  assert.equal(waiting.tools, undefined);

  // 桌面端没报 claude:// 能力（或走的是整页跳转）时，登录结果交不回应用：明确拒绝，不给会跳去真 claude.ai 的地址。
  assert.equal((await request(`${mcp}/start-auth/${uuid}?response_format=json`, { host: "claude.ai" })).body.error.details.error_code, "mcp_sign_in_unavailable");
  assert.equal((await request(`${mcp}/start-auth/${uuid}?browser_handoff=1&desktop_finish=claude`, { host: "claude.ai" })).status, 400);

  const started = (await request(`${mcp}/start-auth/${uuid}?response_format=json&desktop_finish=claude`, { host: "claude.ai" })).body;
  assert.equal(started.finish_in_app, true);
  assert.match(started.state, /^[A-Za-z0-9_-]{16,256}$/);
  const authorize = new URL(started.auth_url);
  assert.equal(authorize.origin + authorize.pathname, "https://auth.example/authorize");
  const redirect = `http://127.0.0.1:${proxyPort}/mcp-oauth-callback`;
  assert.deepEqual(Object.fromEntries(authorize.searchParams), {
    response_type: "code", client_id: "client-1", redirect_uri: redirect, state: started.state,
    code_challenge: authorize.searchParams.get("code_challenge"), code_challenge_method: "S256",
    resource: "https://mcp.auth.example/mcp", scope: "read write",
  });
  assert.deepEqual(mcpFixture.registrations.at(-1).redirect_uris, [redirect]);
  assert.equal(mcpFixture.registrations.at(-1).token_endpoint_auth_method, "none");
  mcpFixture.challenge = authorize.searchParams.get("code_challenge");

  // 浏览器登录完跳回本机：没有本地凭据，state 不对的不认。
  const page = (query) => fetch(`http://127.0.0.1:${proxyPort}/mcp-oauth-callback?${query}`);
  assert.equal((await page("code=code-1&state=wrong")).status, 400);
  const landed = await page(`code=code-1&state=${started.state}`);
  assert.equal(landed.status, 200);
  const link = /href="(claude:\/\/[^"]+)"/.exec(await landed.text())[1].replaceAll("&amp;", "&");
  const handed = new URL(link);
  assert.equal(handed.host + handed.pathname, `claude.ai/mcp-auth-callback/${uuid}`);
  assert.equal(handed.searchParams.get("step"), "finish");
  assert.equal(handed.searchParams.get("state"), started.state);
  assert.equal(handed.searchParams.has("code"), false, "授权码不能出现在交回应用的链接里");
  const ticket = handed.searchParams.get("ticket");
  assert.match(ticket, /^[A-Za-z0-9_-]{16,256}$/);
  assert.deepEqual(mcpFixture.tokenRequests.at(-1), {
    grant_type: "authorization_code", code: "code-1", redirect_uri: redirect,
    code_verifier: mcpFixture.tokenRequests.at(-1).code_verifier, client_id: "client-1", resource: "https://mcp.auth.example/mcp",
  });

  const claim = (value) => request(`/api/mcp/auth_callback?state=${started.state}&ticket=${value}&response_format=json`, { host: "claude.ai" });
  assert.deepEqual((await claim("wrong-ticket-wrong-ticket")).body, { success: false, error_code: "mcp_auth_state_invalid" });
  assert.deepEqual((await claim(ticket)).body, { success: true });
  assert.deepEqual((await claim(ticket)).body, { replayed: true });

  const signedIn = await connectorEvents();
  const base = signedIn.server_base.find((entry) => entry.uuid === uuid);
  assert.equal(base.connected, true);
  assert.equal(base.authStatus, "authenticated");
  assert.equal(base.usedAuthentication, true);
  assert.equal(signedIn.tools.find((entry) => entry.server_uuid === uuid).tools[0].name, "echo");
  assert.equal((await request(`${mcp}/remote_servers/${uuid}`, { host: "claude.ai" })).body.is_authenticated, true);

  const call = () => request(`${mcp}/servers/${uuid}/tools/call`, { host: "claude.ai", body: { tool_name: "echo", arguments: { text: "secret" } } });
  assert.equal((await call()).body.content[0].text, "echo: secret");
  assert.equal(mcpFixture.calls.at(-1).authorization, "Bearer token-1");
  // 令牌过期：用刷新令牌换一个新的，这次调用照常完成。
  mcpFixture.validTokens.delete("token-1");
  assert.equal((await call()).body.content[0].text, "echo: secret");
  assert.equal(mcpFixture.calls.at(-1).authorization, "Bearer token-2");
  assert.equal(mcpFixture.tokenRequests.at(-1).grant_type, "refresh_token");
  // 刷新也不行了：调用失败成一条模型看得懂的工具结果，状态变成要重新登录。
  mcpFixture.validTokens.clear();
  mcpFixture.refreshes = false;
  const expired = (await call()).body;
  assert.equal(expired.is_error, true);
  assert.match(expired.content[0].text, /sign in again/);
  assert.equal((await connectorEvents()).server_base.find((entry) => entry.uuid === uuid).authStatus, "token_invalid");

  // 断开：令牌丢掉，显示为未连接。
  assert.equal((await request(`${mcp}/logout/${uuid}`, { host: "claude.ai", method: "POST" })).status, 200);
  const loggedOut = await connectorEvents();
  assert.equal(loggedOut.server_base.find((entry) => entry.uuid === uuid).authStatus, "auth_required");
  assert.equal((await request(`${mcp}/remote_servers/${uuid}`, { host: "claude.ai" })).body.is_authenticated, false);
  await request(`${mcp}/remote_servers/${uuid}`, { host: "claude.ai", method: "DELETE" });
});

test("frame type catalog and plugin registry return validated list shapes", async () => {
  const types = await request("/api/frame/types", { host: "claude.ai" });
  assert.equal(types.status, 200);
  assert.deepEqual(types.body.types, []);
  const registry = await request("/api/organizations/local/plugins/registry", { host: "claude.ai" });
  assert.equal(registry.status, 200);
  assert.deepEqual(registry.body.data, []);
});

for (const host of [undefined, "api.anthropic.com", "claude.ai"]) {
  test(`policy limits keep the object shape the desktop validator expects over ${host || "direct HTTP"}`, async () => {
    const result = await request("/api/claude_code/policy_limits", { host });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.restrictions, {});
    assert.deepEqual(result.body.compliance_taints, []);
  });
}

for (const host of [undefined, "api.anthropic.com", "claude.ai"]) {
  test(`plugin directory returns an array page over ${host || "direct HTTP"}`, async () => {
    // api.anthropic.com 上的公开目录转给真接口，另有用例。
    const paths = ["/api/organizations/local/directory/plugins"];
    if (host !== "api.anthropic.com") paths.push("/api/directory/plugins");
    for (const pathname of paths) {
      const result = await request(pathname, { host });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.data, []);
      assert.equal(result.body.next_page, null);
      assert.deepEqual(result.body.facets, {});
      assert.deepEqual(result.body.omitted, []);
    }
  });
}

test("the public plugin directory comes from Anthropic and is readable cross-origin from claude.ai", async () => {
  const before = upstreamRequests.length;
  const listed = await request("/api/directory/plugins?limit=24&order_by=trending", { host: "api.anthropic.com" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.data, [{ id: "plugin_fixture" }]);
  assert.equal(listed.headers["access-control-allow-origin"], "*");
  assert.deepEqual(upstreamRequests.slice(before), [
    { host: "api.anthropic.com", url: "/api/directory/plugins?limit=24&order_by=trending" },
  ]);

  // 真接口拒绝（地区限制等）时回空目录，同样要带 CORS 头：缺了页面读不到，整页报「无法加载插件」。
  const refused = await request("/api/directory/plugins?refuse=1", { host: "api.anthropic.com" });
  assert.equal(refused.status, 200);
  assert.deepEqual(refused.body, { data: [], next_page: null, facets: {}, omitted: [] });
  assert.equal(refused.headers["access-control-allow-origin"], "*");
});

for (const host of [undefined, "api.anthropic.com", "claude.ai"]) {
  test(`DXT extension lists return entries and total over ${host || "direct HTTP"}`, async () => {
    for (const pathname of [
      "/api/organizations/local/dxt/extensions",
      "/api/organizations/local/dxt/installable_extensions",
    ]) {
      const result = await request(pathname, { host });
      assert.equal(result.status, 200);
      assert.deepEqual(result.body.entries, []);
      assert.equal(result.body.total, 0);
    }
  });
}

test("recorded Desktop title endpoints fall back without model requests when Claude Code is unavailable", async () => {
  const gatewayCalls = gatewayRequests.length;
  const created = await request("/api/organizations/11111111-2222-4333-8444-555555555556/chat_conversations", {
    host: "claude.ai",
    body: {},
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.name, "");

  const titled = await request(
    `/api/organizations/11111111-2222-4333-8444-555555555556/chat_conversations/${created.body.uuid}/title`,
    {
      host: "claude.ai",
      body: { message_content: "Message 1: Golden Gate Bridge presentation\n\nMessage 2: Sure!", recent_titles: [] },
    },
  );
  assert.equal(titled.status, 200);
  assert.equal(titled.body.title, "Golden Gate Bridge presentatio…");

  const fetched = await request(
    `/api/organizations/11111111-2222-4333-8444-555555555556/chat_conversations/${created.body.uuid}`,
    { host: "claude.ai" },
  );
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.name, titled.body.title);
  assert.deepEqual(fetched.body.settings, {});
  assert.deepEqual(fetched.body.files, []);
  assert.deepEqual(fetched.body.sync_sources, []);

  const coworkTitle = await request(
    "/api/organizations/11111111-2222-4333-8444-555555555556/dust/generate_session_title",
    { host: "claude.ai", body: { first_session_message: "Build a Golden Gate Bridge PowerPoint", surface: "cowork" } },
  );
  assert.equal(coworkTitle.status, 200);
  assert.equal(coworkTitle.body.title, "Build a Golden Gate Bridge Pow…");

  const codeTitle = await request(
    "/api/organizations/11111111-2222-4333-8444-555555555556/dust/generate_title_and_branch",
    { host: "claude.ai", body: { first_session_message: "Add a title fixture" } },
  );
  assert.equal(codeTitle.status, 200);
  assert.deepEqual(codeTitle.body, { title: "Add a title fixture", branch_name: "claude/add-a-title-fixture" });
  assert.equal(gatewayRequests.length, gatewayCalls);
});

test("document navigations replay the app shell rather than logged-out landing stubs", async () => {
  const cacheWrite = (key, body, meta) => {
    const cp = path.join(dictationCacheDir, crypto.createHash("sha1").update(key).digest("hex"));
    fs.writeFileSync(cp, body);
    fs.writeFileSync(`${cp}.json`, JSON.stringify(meta));
  };
  const shell = `<!doctype html><html data-build-id="recorded-shell"><head><meta charset="UTF-8"></head><body><div id="root">${"x".repeat(5000)}</div></body></html>`;
  // 登出落地页桩体：上游匿名抓取的 claude.ai/ 就是这种小 HTML
  cacheWrite("claude.ai/", "<html>redirect</html>", { status: 200, headers: { "content-type": "text/html" }, url: "claude.ai/" });
  cacheWrite("claude.ai/new", "<html>redirect</html>", { status: 200, headers: { "content-type": "text/html" }, url: "claude.ai/new" });
  cacheWrite("claude.ai/epitaxy", shell, { status: 200, headers: { "content-type": "text/html" }, url: "claude.ai/epitaxy" });

  // `/` 会先被更早的 302 分支重写到 /new；其余文档导航直接回真外壳
  const root = await requestText("claude.ai", "/", { accept: "text/html" });
  assert.equal(root.status, 302);
  for (const navPath of ["/new", "/chat", "/settings/general"]) {
    const result = await requestText("claude.ai", navPath, { accept: "text/html" });
    assert.equal(result.status, 200, navPath);
    assert.match(result.body, /data-build-id="recorded-shell"/, navPath);
    assert.doesNotMatch(result.body, /^<html>redirect<\/html>$/, navPath);
  }
});
