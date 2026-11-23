// 连接器：Claude 账号侧的「远程 MCP 服务器」后端，由本地服务顶上。
//
// 登录官方账号时，连接器记在 Anthropic 那边：界面上添加 / 连接 / 登录都调 claude.ai 的接口，
// 登录用的令牌也存在那边；Cowork 和 Code 会话里调用连接器的工具时，桌面端向
// `claude.ai/api/organizations/<org>/mcp/servers/<uuid>/tools/call` 发一个请求，由服务端去连真正的服务器。
// 本地没有账号，这里自己当这个后端：记下连接器、自己做 MCP 客户端、自己走 OAuth。
//
// 登录的过程（只支持「在应用内完成」这一种，另一种要经过真正的 claude.ai）：
//   页面 GET start-auth → 这里发现授权服务器、动态注册一个客户端、给出授权地址 → 桌面端用系统浏览器打开它 →
//   授权服务器带着 code 跳回本机回调地址 → 这里换令牌，再把浏览器引到 `claude://claude.ai/mcp-auth-callback/<uuid>` →
//   桌面端把这个链接交给页面 → 页面 GET /api/mcp/auth_callback 认领结果。

import crypto from "node:crypto";

const PROTOCOL_VERSION = "2025-06-18";
const CONNECTED_TTL_MS = 5 * 60_000;
const FAILED_TTL_MS = 20_000;
const SIGN_IN_TTL_MS = 30 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
// 桌面端自己等 180 秒。
const TOOL_CALL_TIMEOUT_MS = 170_000;
const DEEP_LINK_SCHEMES = new Set(["claude", "claude-nest", "claude-dev", "claude-nest-dev"]);

const isText = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.length <= max;
const token = () => crypto.randomBytes(32).toString("base64url");

function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/** 状态文件里的一条连接器记录是否完整（`auth` 里是令牌，`oauth` 里是注册到的客户端和授权服务器地址）。 */
export function validConnector(connector) {
  return connector !== null && typeof connector === "object" && /^[0-9a-f-]{36}$/.test(connector.uuid) &&
    isText(connector.name, 256) && httpsUrl(connector.url) !== null && isText(connector.createdAt, 64) &&
    (connector.auth === undefined || isText(connector.auth?.accessToken, 16384)) &&
    (connector.oauth === undefined || isText(connector.oauth?.clientId, 4096) && httpsUrl(connector.oauth.tokenEndpoint) !== null);
}

/** 接口里的连接器记录。 */
export function connectorRecord(connector) {
  return {
    uuid: connector.uuid,
    name: connector.name,
    url: connector.url,
    created_at: connector.createdAt,
    updated_at: connector.updatedAt ?? connector.createdAt,
    custom_oauth_client_id: null,
    mcp_directory_server_uuid: connector.directoryUuid ?? null,
    installation_source: null,
    is_authenticated: Boolean(connector.auth?.accessToken),
  };
}

/** 调用方能看懂的失败：`code` 进接口的 error_code，`status` 是 HTTP 状态。 */
export class ConnectorError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

class McpError extends Error {
  constructor(kind, message, challenge) {
    super(message);
    this.kind = kind;
    this.challenge = challenge;
  }
}

/** SSE 正文里的各条消息（每个事件的 data 是一条 JSON-RPC 消息）。 */
function sseMessages(text) {
  const messages = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch {}
  }
  return messages;
}

/**
 * `connectors`：uuid → 记录，由调用方持久化（改动后调 `changed`）。
 * `send(url, { method, headers, body, timeout, until })` → `{ status, headers, body }`：发一个请求；
 * `until(正文)` 返回真时不等连接结束就交回（SSE 回复不一定会自己结束）。
 * `redirectUri()`：浏览器登录完跳回来的本机地址。
 */
export function createConnectorService({ connectors, send, changed, redirectUri }) {
  const sessions = new Map();
  const statuses = new Map();
  const signIns = new Map();
  const removed = new Set();
  let nextId = 1;

  const forget = (uuid) => {
    sessions.delete(uuid);
    statuses.delete(uuid);
  };

  async function getJson(address) {
    const response = await send(address, { headers: { accept: "application/json" }, timeout: REQUEST_TIMEOUT_MS });
    if (response.status !== 200) return null;
    try { return JSON.parse(response.body.toString("utf8")); } catch { return null; }
  }

  // ── MCP 客户端（Streamable HTTP） ─────────────────────────────

  async function exchange(connector, session, message, timeout = REQUEST_TIMEOUT_MS) {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (session?.id) headers["mcp-session-id"] = session.id;
    if (session?.protocolVersion) headers["mcp-protocol-version"] = session.protocolVersion;
    if (connector.auth?.accessToken) headers.authorization = `Bearer ${connector.auth.accessToken}`;
    const answered = (text) => sseMessages(text).find((entry) => entry?.id === message.id && ("result" in entry || "error" in entry));
    const response = await send(connector.url, {
      method: "POST", headers, body: JSON.stringify(message), timeout,
      until: message.id === undefined ? undefined : (text) => answered(text) !== undefined,
    });
    if (response.status === 401) throw new McpError("unauthorized", "sign-in required", String(response.headers["www-authenticate"] ?? ""));
    if (response.status === 404 && session?.id) throw new McpError("session", "session expired");
    if (response.status < 200 || response.status >= 300) throw new McpError("http", `server answered ${response.status}`);
    if (message.id === undefined) return { response };
    const text = response.body.toString("utf8");
    let reply;
    if (String(response.headers["content-type"] ?? "").includes("text/event-stream")) reply = answered(text);
    else try { reply = JSON.parse(text); } catch {}
    if (!reply || reply.id !== message.id) throw new McpError("http", "server sent no answer");
    if (reply.error) throw new McpError("rpc", String(reply.error.message ?? "request failed"));
    return { response, result: reply.result ?? {} };
  }

  async function open(connector) {
    const { response, result } = await exchange(connector, null, {
      jsonrpc: "2.0", id: nextId++, method: "initialize",
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "ClaudeMom", version: "1" } },
    });
    const session = {
      id: typeof response.headers["mcp-session-id"] === "string" ? response.headers["mcp-session-id"] : undefined,
      protocolVersion: typeof result.protocolVersion === "string" ? result.protocolVersion : PROTOCOL_VERSION,
      info: result,
    };
    await exchange(connector, session, { jsonrpc: "2.0", method: "notifications/initialized" });
    sessions.set(connector.uuid, session);
    return session;
  }

  /** 发一个请求：没有会话先握手；令牌过期换一次新的、会话过期重新握手，各重试一次。 */
  async function call(connector, method, params, timeout) {
    for (let attempt = 0; ; attempt++) {
      try {
        const session = sessions.get(connector.uuid) ?? await open(connector);
        return (await exchange(connector, session, { jsonrpc: "2.0", id: nextId++, method, params }, timeout)).result;
      } catch (error) {
        const retry = attempt < 2 && (error.kind === "session" || error.kind === "unauthorized" && await refresh(connector));
        sessions.delete(connector.uuid);
        if (!retry) throw error;
      }
    }
  }

  async function probe(connector) {
    if (connector.disconnected) return { connected: false, authStatus: "auth_required" };
    try {
      const tools = [];
      let cursor;
      do {
        const page = await call(connector, "tools/list", cursor ? { cursor } : {});
        if (Array.isArray(page.tools)) tools.push(...page.tools.filter((tool) => isText(tool?.name, 256)));
        cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      } while (cursor && tools.length < 2000);
      return { connected: true, tools, info: sessions.get(connector.uuid)?.info ?? {} };
    } catch (error) {
      if (error.kind === "unauthorized") {
        return { connected: false, authStatus: connector.auth?.accessToken ? "token_invalid" : "auth_required", challenge: error.challenge };
      }
      return { connected: false, connectionError: String(error.message ?? "connection failed").slice(0, 300) };
    }
  }

  /** 连接器现在的状态（能不能连上、要不要登录、有哪些工具）。结果留一会儿，同时来的查询共用一次探测。 */
  function status(connector) {
    const cached = statuses.get(connector.uuid);
    if (cached?.pending) return cached.pending;
    if (cached && Date.now() - cached.at < (cached.value.connected ? CONNECTED_TTL_MS : FAILED_TTL_MS)) return Promise.resolve(cached.value);
    const pending = probe(connector).then((value) => {
      if (statuses.get(connector.uuid)?.pending === pending) statuses.set(connector.uuid, { at: Date.now(), value });
      return value;
    });
    statuses.set(connector.uuid, { pending });
    return pending;
  }

  // ── OAuth ─────────────────────────────────────────────────────

  /** 找到这个服务器的授权服务器：先问受保护资源的元数据，再问授权服务器的元数据。 */
  async function discover(connector, challenge) {
    const server = new URL(connector.url);
    const path = server.pathname.replace(/\/+$/, "");
    const hinted = httpsUrl(/resource_metadata="?([^",\s]+)/.exec(challenge ?? "")?.[1]);
    let resource = null;
    for (const address of [hinted?.href, `${server.origin}/.well-known/oauth-protected-resource${path}`, `${server.origin}/.well-known/oauth-protected-resource`]) {
      if (!address) continue;
      resource = await getJson(address).catch(() => null);
      if (resource) break;
    }
    const issuer = httpsUrl(Array.isArray(resource?.authorization_servers) ? resource.authorization_servers[0] : null) ?? new URL(server.origin);
    const issuerPath = issuer.pathname.replace(/\/+$/, "");
    let metadata = null;
    for (const address of [
      `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
      `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
      ...(issuerPath ? [`${issuer.origin}${issuerPath}/.well-known/openid-configuration`] : []),
    ]) {
      metadata = await getJson(address).catch(() => null);
      if (metadata?.authorization_endpoint && metadata.token_endpoint) break;
      metadata = null;
    }
    const endpoints = {
      authorizationEndpoint: httpsUrl(metadata?.authorization_endpoint)?.href,
      tokenEndpoint: httpsUrl(metadata?.token_endpoint)?.href,
      registrationEndpoint: httpsUrl(metadata?.registration_endpoint)?.href,
    };
    if (!endpoints.authorizationEndpoint || !endpoints.tokenEndpoint) {
      throw new ConnectorError("mcp_auth_discovery_failed", "This connector does not describe how to sign in.");
    }
    // 没有动态注册入口：这个服务器只认预先登记的客户端（Anthropic 的），本地登不了。
    if (!endpoints.registrationEndpoint) {
      throw new ConnectorError("mcp_client_registration_unavailable", "This connector only accepts sign-ins through Anthropic.");
    }
    const scope = /scope="([^"]+)"/.exec(challenge ?? "")?.[1] ??
      (Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.filter((entry) => typeof entry === "string").join(" ") : "");
    return { ...endpoints, scope, resource: httpsUrl(resource?.resource)?.href ?? connector.url };
  }

  async function register(endpoints, redirect) {
    const response = await send(endpoints.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "ClaudeMom", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"], token_endpoint_auth_method: "none",
      }),
      timeout: REQUEST_TIMEOUT_MS,
    });
    let client = null;
    try { client = JSON.parse(response.body.toString("utf8")); } catch {}
    if (response.status < 200 || response.status >= 300 || !isText(client?.client_id)) {
      throw new ConnectorError("mcp_client_registration_failed", "This connector refused to register a sign-in client.");
    }
    return { clientId: client.client_id, clientSecret: isText(client.client_secret) ? client.client_secret : undefined };
  }

  async function requestToken(oauth, fields) {
    const form = new URLSearchParams({ ...fields, client_id: oauth.clientId, resource: oauth.resource });
    if (oauth.clientSecret) form.set("client_secret", oauth.clientSecret);
    const response = await send(oauth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
      timeout: REQUEST_TIMEOUT_MS,
    });
    let granted = null;
    try { granted = JSON.parse(response.body.toString("utf8")); } catch {}
    if (response.status !== 200 || !isText(granted?.access_token, 16384)) return null;
    return {
      accessToken: granted.access_token,
      refreshToken: isText(granted.refresh_token, 16384) ? granted.refresh_token : fields.refresh_token,
      expiresAt: Number.isFinite(granted.expires_in) ? Date.now() + granted.expires_in * 1000 : undefined,
    };
  }

  async function refresh(connector) {
    if (!connector.oauth || !connector.auth?.refreshToken) return false;
    const auth = await requestToken(connector.oauth, { grant_type: "refresh_token", refresh_token: connector.auth.refreshToken }).catch(() => null);
    if (!auth) return false;
    connector.auth = auth;
    changed();
    return true;
  }

  return {
    list: () => [...connectors.values()],
    get: (uuid) => connectors.get(uuid),

    /** 添加连接器。地址已经加过的直接给回那一条。 */
    create({ name, url, directoryUuid }) {
      const address = httpsUrl(url);
      if (!address) throw new ConnectorError("mcp_server_url_invalid", "A connector needs an https address.");
      const existing = [...connectors.values()].find((connector) => connector.url === address.href);
      if (existing) return { connector: existing, existing: true };
      const connector = {
        uuid: crypto.randomUUID(),
        name: isText(name, 256) ? name : address.hostname,
        url: address.href,
        directoryUuid: /^[0-9a-f-]{36}$/.test(String(directoryUuid)) ? directoryUuid : undefined,
        createdAt: new Date().toISOString(),
      };
      connectors.set(connector.uuid, connector);
      removed.delete(connector.uuid);
      changed();
      return { connector, existing: false };
    },

    rename(connector, name) {
      if (!isText(name, 256)) return;
      connector.name = name;
      connector.updatedAt = new Date().toISOString();
      changed();
    },

    remove(uuid) {
      if (!connectors.delete(uuid)) return;
      forget(uuid);
      removed.add(uuid);
      changed();
    },

    /** 断开：丢掉令牌，之后显示为未连接，再点「连接」重新来。 */
    logout(connector) {
      connector.auth = undefined;
      connector.disconnected = true;
      forget(connector.uuid);
      changed();
    },

    refreshStatus: (connector) => forget(connector.uuid),

    /** 不触发探测：只看上次的结果。 */
    connected: (connector) => statuses.get(connector.uuid)?.value?.connected === true,

    /** 「已连接的连接器」事件流：先给名单，再逐个给状态和工具，最后明确结束。 */
    async stream(write) {
      const list = [...connectors.values()];
      write("server_list", {
        servers: list.map(({ uuid, name, url, directoryUuid }) => ({ uuid, name, url, directoryEntryUuid: directoryUuid })),
        deleted_server_uuids: [...removed],
      });
      await Promise.all(list.map(async (connector) => {
        const current = await status(connector);
        if (!connectors.has(connector.uuid)) return;
        const { uuid, name, url } = connector;
        write("server_base", {
          uuid, name, url,
          connected: current.connected,
          usedAuthentication: current.connected && Boolean(connector.auth?.accessToken),
          authStatus: current.connected ? (connector.auth?.accessToken ? "authenticated" : "not_required") : current.authStatus,
          connectionError: current.connectionError,
          isDirectoryServer: Boolean(connector.directoryUuid),
          directoryEntryUuid: connector.directoryUuid,
          instructions: typeof current.info?.instructions === "string" ? current.info.instructions : undefined,
          protocolVersion: current.info?.protocolVersion,
          capabilities: current.info?.capabilities,
          serverInfo: current.info?.serverInfo,
        });
        if (!current.connected) return;
        write("tools", {
          server_uuid: uuid,
          tools: current.tools.map((tool) => ({
            name: tool.name,
            description: typeof tool.description === "string" ? tool.description : "",
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
            annotations: tool.annotations,
            displayName: tool.annotations?.title ?? tool.title ?? tool.name,
            enabled_key: `${uuid}:${tool.name}`,
            always_approved_key: `${uuid}:${tool.name}:always`,
            _meta: tool._meta,
          })),
        });
      }));
      write("first_pass_complete", {});
      write("completed", {});
    },

    /**
     * 「连接」：不用登录的服务器直接算连上；要登录的给出授权地址。
     * `scheme` 是桌面端报的 claude:// 链接协议；没有它就没法把登录结果交回应用。
     */
    async startAuth(connector, scheme) {
      connector.disconnected = false;
      forget(connector.uuid);
      const current = await status(connector);
      if (current.connected) return { connected: true };
      if (!current.authStatus) throw new ConnectorError("mcp_server_unreachable", current.connectionError ?? "The connector could not be reached.", 502);
      if (!DEEP_LINK_SCHEMES.has(scheme)) {
        throw new ConnectorError("mcp_sign_in_unavailable", "Signing in needs Claude to handle claude:// links on this computer.");
      }
      const redirect = redirectUri();
      const endpoints = await discover(connector, current.challenge);
      // 回调地址带着本地服务的端口，端口变了要重新登记。
      const client = connector.oauth?.redirectUri === redirect && connector.oauth.registrationEndpoint === endpoints.registrationEndpoint
        ? { clientId: connector.oauth.clientId, clientSecret: connector.oauth.clientSecret }
        : await register(endpoints, redirect);
      connector.oauth = { ...client, redirectUri: redirect, ...endpoints };
      changed();
      const state = token();
      const verifier = token();
      for (const [key, flow] of signIns) if (Date.now() - flow.at > SIGN_IN_TTL_MS) signIns.delete(key);
      signIns.set(state, { at: Date.now(), uuid: connector.uuid, verifier, scheme });
      const authorize = new URL(endpoints.authorizationEndpoint);
      for (const [name, value] of Object.entries({
        response_type: "code", client_id: client.clientId, redirect_uri: redirect, state,
        code_challenge: crypto.createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
        resource: endpoints.resource, ...(endpoints.scope ? { scope: endpoints.scope } : {}),
      })) authorize.searchParams.set(name, value);
      return { auth_url: authorize.href, state, finish_in_app: true };
    },

    /** 浏览器带着 code 跳回来：换令牌，给出把结果交回应用的 claude:// 链接。state 对不上返回 null。 */
    async finishAuth({ state, code, error }) {
      const flow = signIns.get(state);
      const connector = flow && connectors.get(flow.uuid);
      if (!connector || Date.now() - flow.at > SIGN_IN_TTL_MS) return null;
      if (!flow.result) {
        // 同一个回调只换一次令牌。
        flow.result = { success: false, error_code: "mcp_provider_error_redirect" };
        flow.ticket = token();
        if (!error && isText(code, 4096) && connector.oauth) {
          const auth = await requestToken(connector.oauth, {
            grant_type: "authorization_code", code, redirect_uri: connector.oauth.redirectUri, code_verifier: flow.verifier,
          }).catch(() => null);
          if (auth) {
            connector.auth = auth;
            connector.disconnected = false;
            forget(connector.uuid);
            changed();
            flow.result = { success: true };
          } else {
            flow.result = { success: false, error_code: "mcp_token_exchange_failed" };
          }
        }
      }
      const link = new URL(`${flow.scheme}://claude.ai/mcp-auth-callback/${connector.uuid}`);
      link.searchParams.set("step", "finish");
      link.searchParams.set("state", state);
      link.searchParams.set("ticket", flow.ticket);
      if (!flow.result.success) link.searchParams.set("error", flow.result.error_code);
      return { link: link.href, success: flow.result.success, name: connector.name };
    },

    /** 页面拿着 claude:// 链接里的 state 和 ticket 来认领登录结果。 */
    claim(state, ticket) {
      const flow = signIns.get(state);
      if (!flow?.ticket || flow.ticket !== ticket) return { success: false, error_code: "mcp_auth_state_invalid" };
      if (flow.claimed) return { replayed: true };
      flow.claimed = true;
      return flow.result;
    },

    /** 会话里的一次工具调用，结果按桌面端读的字段给。失败也给成工具结果，模型能看到原因。 */
    async callTool(connector, name, args) {
      try {
        const result = await call(connector, "tools/call", { name, arguments: args ?? {} }, TOOL_CALL_TIMEOUT_MS);
        return {
          content: Array.isArray(result.content) ? result.content : [],
          is_error: result.isError === true,
          structured_content: result.structuredContent,
          meta: result._meta,
        };
      } catch (error) {
        if (error.kind === "unauthorized") forget(connector.uuid);
        const reason = error.kind === "unauthorized"
          ? `${connector.name} needs you to sign in again: open it in Claude's connectors and choose Connect.`
          : `${connector.name} could not run this tool: ${error.message}`;
        return { content: [{ type: "text", text: reason }], is_error: true };
      }
    },
  };
}
