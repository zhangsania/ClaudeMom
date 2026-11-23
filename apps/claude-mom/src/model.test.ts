import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { claudeState, emptyProfile, formatWindow, normalizeModels, profileProblem, setupSteps, templateLabel, type ClaudeStatus } from "./model.ts";

const status = (patch: Partial<ClaudeStatus> = {}): ClaudeStatus => ({
  supported: true, sourceApp: "", version: "1.0", claudeRunning: false, running: false, connected: false,
  caReady: true, caTrusted: true, caMachineSupported: true, caMachineTrusted: false, nodeAvailable: true, dictationReady: true, models: [], needsRestart: false,
  config: { enabled: true, model: "", localization: true, voiceInput: false, computerUse: false, backgroundMode: false },
  ...patch,
});

test("分组需要 API Key 和默认模型", () => {
  const profile = { ...emptyProfile(), apiKey: "sk-test-only", model: "glm-5" };
  assert.equal(profileProblem(profile), null);
  assert.equal(profileProblem({ ...profile, apiKey: "" }), "请输入有效的 API Key");
  assert.equal(profileProblem({ ...profile, apiKey: "sk-test\nkey" }), "请输入有效的 API Key");
  assert.equal(profileProblem({ ...profile, model: " " }), "选一个默认模型");
});

test("模型列表去重，默认模型排第一", () => {
  assert.deepEqual(normalizeModels(["b", " a ", "b", ""], "a"), ["a", "b"]);
});

test("状态文案：已连接、运行中、外部打开、未启动", () => {
  assert.deepEqual(claudeState(null, null), { text: "正在检测 Claude…", tone: "busy" });
  assert.equal(claudeState(status({ connected: true }), null).tone, "ok");
  assert.equal(claudeState(status({ claudeRunning: true }), null).tone, "warn");
  assert.equal(claudeState(status(), null).text, "未启动");
  assert.equal(claudeState(status(), "launch").text, "正在启动…");
  assert.equal(claudeState(status({ supported: false }), null).text, "没有找到 Claude Desktop");
});

test("启动前清单按顺序列出缺的步骤", () => {
  const ready = { ...emptyProfile(), apiKey: "sk-test-only", model: "m" };
  assert.deepEqual(setupSteps(status(), ready), []);
  assert.deepEqual(setupSteps(status({ caTrusted: false, nodeAvailable: false }), null).map((step) => step.id), ["upstream", "node", "trust"]);
  // 第三方模式不经代理：不要求信任证书。
  assert.deepEqual(setupSteps(status({ caTrusted: false, config: { ...status().config, threePMode: true } }), null).map((step) => step.id), ["upstream"]);
});

test("窗口显示", () => {
  assert.equal(formatWindow(null), "200k");
  assert.equal(formatWindow(1_000_000), "1M");
  assert.equal(formatWindow(1_100_000), "1.1M");
  assert.equal(formatWindow(400_000), "400k");
});

test("前端调用的命令都在后端注册了", () => {
  const app = readFileSync(new URL("./ClaudeMomApp.tsx", import.meta.url), "utf8");
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  // 命令名有的直接传给 invoke，有的经 bookCall 转一手：按字面量收。
  const called = new Set([...app.matchAll(/"(claude_(?:mom|local)_[a-z_]+)"/g)].map((match) => match[1]));
  assert.ok(called.has("claude_mom_import_web_key"));
  for (const command of called) assert.ok(new RegExp(`::${command},`).test(lib), `${command} 没有注册`);
});

test("recorded template versions are labelled by build date and id", () => {
  const label = templateLabel({ build: "a4ced7f85b", builtAt: 1794603257 });
  assert.match(label, /^2026-11-1[34] · a4ced7f85b$/);
  assert.equal(templateLabel({ build: "x1", builtAt: null }), "x1");
});
