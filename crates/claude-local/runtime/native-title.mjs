import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const TITLE_TIMEOUT_MS = 30_000;
const MAX_TITLE_JOBS = 2;
const SDK_OUTPUT_LIMIT = 1 << 20;

export async function findDesktopCode(roots) {
  const executable = process.platform === "win32"
    ? ["claude.exe"]
    : ["claude.app/Contents/MacOS/claude", "claude"];
  const entries = (dir) => fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const root of roots) {
    const versions = (await entries(root)).filter((entry) => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name));
    versions.sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }));
    for (const version of versions) {
      const directory = path.join(root, version.name);
      for (const slot of await entries(directory)) {
        if (!slot.isDirectory() || !/^[0-9a-f]{12}$/.test(slot.name)) continue;
        const install = path.join(directory, slot.name);
        const digest = (await fs.readFile(path.join(install, ".verified"), "utf8").catch(() => "")).trim();
        if (!/^[0-9a-f]{64}$/.test(digest) || !digest.startsWith(slot.name)) continue;
        for (const name of executable) {
          const bin = await fs.realpath(path.join(install, name)).catch(() => null);
          if (!bin || path.isAbsolute(path.relative(install, bin)) || path.relative(install, bin).startsWith("..")) continue;
          if ((await fs.stat(bin).catch(() => null))?.isFile()) return bin;
        }
      }
    }
  }
  return null;
}

function titleEnvironment(directory, port, token, model) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    /^(path|systemroot|windir|comspec|systemdrive|pathext)$/i.test(name)));
  return {
    ...env,
    HOME: directory, USERPROFILE: directory, APPDATA: directory, LOCALAPPDATA: directory,
    TMPDIR: directory, TEMP: directory, TMP: directory, CLAUDE_CONFIG_DIR: directory,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_MAX_RETRIES: "0",
    DISABLE_AUTOUPDATER: "1",
  };
}

function sdkTitle(binary, description, model, options, spawnCli) {
  return new Promise((resolve) => {
    const child = spawnCli(binary, [
      "-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--no-session-persistence", "--setting-sources=", "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}', "--tools", "", "--model", model,
    ], { ...options, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let title = null;
    let output = "";
    let size = 0;
    let initialized = false;
    let finished = false;
    const timer = setTimeout(stop, TITLE_TIMEOUT_MS);
    function stop() {
      if (finished) return;
      finished = true;
      child.stdin.destroy();
      child.kill("SIGKILL");
    }
    function send(id, request) {
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request }) + "\n");
    }
    child.on("error", stop);
    child.stdin.on("error", stop);
    child.stdout.on("error", stop);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(title);
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > SDK_OUTPUT_LIMIT) return stop();
      output += chunk;
      let newline;
      while (!finished && (newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline);
        output = output.slice(newline + 1);
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (frame?.type !== "control_response") continue;
        const reply = frame.response;
        if (reply?.request_id === "title-init" && !initialized) {
          if (reply.subtype !== "success") return stop();
          initialized = true;
          send("title-generate", { subtype: "generate_session_title", description, persist: false });
        } else if (reply?.request_id === "title-generate" && initialized) {
          const value = reply.response?.title;
          if (reply.subtype === "success" && typeof value === "string" && value.trim()) title = value;
          stop();
        }
      }
    });
    send("title-init", { subtype: "initialize", hooks: {}, sdkMcpServers: [] });
  });
}

export function createNativeTitles({ roots, port, model, spawnCli = spawn, onUnavailable = () => {} }) {
  const keys = new Set();
  let jobs = 0;
  return {
    accepts: (key) => keys.has(key),
    async generate(description) {
      if (typeof description !== "string" || !description.trim() || jobs >= MAX_TITLE_JOBS || !roots.length) return null;
      jobs++;
      const key = randomBytes(32).toString("hex");
      let directory;
      try {
        const binary = await findDesktopCode(roots);
        if (!binary) {
          onUnavailable("Desktop Code is not ready");
          return null;
        }
        directory = await fs.mkdtemp(path.join(os.tmpdir(), "yclaude-title-"));
        keys.add(key);
        const result = await sdkTitle(binary, description, model, {
          cwd: directory,
          env: titleEnvironment(directory, port(), key, model),
        }, spawnCli);
        if (result === null) onUnavailable("Desktop Code returned no title");
        return result;
      } catch {
        onUnavailable("Desktop Code title launch failed");
        return null;
      } finally {
        keys.delete(key);
        if (directory) await fs.rm(directory, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
        jobs--;
      }
    },
  };
}
