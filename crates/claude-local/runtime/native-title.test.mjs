import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createNativeTitles } from "./native-title.mjs";

async function installFixture(root) {
  const install = path.join(root, "2.1.325", "a".repeat(12));
  const binary = process.platform === "win32" ? "claude.exe" : "claude";
  await fs.mkdir(install, { recursive: true });
  await fs.writeFile(path.join(install, ".verified"), "a".repeat(64));
  await fs.writeFile(path.join(install, binary), "");
  return fs.realpath(path.join(install, binary));
}

test("titles use the untouched native SDK command and revoke the job credential on exit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "title-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = await installFixture(root);
  const description = "Message 1: Review fixture.\n\nMessage 2: Continue.\n";
  const nativeResult = "Fixture title";
  let jobEnv;
  let jobKey;
  let frames;
  const titles = createNativeTitles({
    roots: [root], port: () => 49173, model: "claude-fixture",
    spawnCli(binary, argv, { cwd, env }) {
      assert.equal(binary, executable);
      assert.ok(argv.includes("--no-session-persistence"));
      assert.ok(argv.includes("--setting-sources="));
      assert.equal(env.CLAUDE_CONFIG_DIR, cwd);
      assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:49173");
      assert.equal(env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-fixture");
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      jobEnv = env;
      jobKey = env.ANTHROPIC_AUTH_TOKEN;
      assert.match(jobKey, /^[0-9a-f]{64}$/);
      assert.equal(titles.accepts(jobKey), true);
      assert.equal(titles.accepts("fixture-other-key"), false);

      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => queueMicrotask(() => child.emit("close", 0));
      frames = [];
      child.stdin.setEncoding("utf8").on("data", (line) => {
        const frame = JSON.parse(line);
        frames.push(frame);
        const result = {
          type: "control_response",
          response: { request_id: frame.request_id, subtype: "success", response: { title: nativeResult } },
        };
        queueMicrotask(() => {
          const raw = JSON.stringify(result) + "\n";
          child.stdout.write(raw.slice(0, 12));
          child.stdout.write(raw.slice(12));
        });
      });
      return child;
    },
  });
  assert.equal(await titles.generate(description), nativeResult);
  assert.deepEqual(frames.map(({ request }) => request), [
    { subtype: "initialize", hooks: {}, sdkMcpServers: [] },
    { subtype: "generate_session_title", description, persist: false },
  ]);
  assert.equal(titles.accepts(jobKey), false);
  await assert.rejects(fs.stat(jobEnv.CLAUDE_CONFIG_DIR), { code: "ENOENT" });
});

test("a missing Desktop installation does not spawn a CLI or use an ambient executable", async () => {
  let spawnCount = 0;
  const titles = createNativeTitles({
    roots: [path.join(os.tmpdir(), "nonexistent-desktop-title-fixture")],
    port: () => 49173,
    model: "claude-fixture",
    spawnCli() { spawnCount++; },
  });
  assert.equal(await titles.generate("Local feature review"), null);
  assert.equal(spawnCount, 0);
});
