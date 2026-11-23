/**
 * ClaudeMom 界面的纯逻辑：后端数据类型、状态文案、表单校验。不依赖 React / Tauri，便于单测。
 */

export type CommandStatus = "ok" | "failed" | string;
export type CommandResult<T> = T & { status: CommandStatus; message: string };

export type UpstreamSource = "manual" | "ccswitch" | "magpie" | "codexpp";

/** 一组上游（与 core `claude_mom::UpstreamProfile` 字段一致）。 */
export type UpstreamProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  smallModel: string;
  models: string[];
  contextWindow: number | null;
  /** 模型显示名（上游 `/v1/models` 的 display_name）。 */
  modelNames: Record<string, string>;
  source: UpstreamSource | string;
  sourceId: string;
};

export type UpstreamBook = { profiles: UpstreamProfile[]; activeId: string | null; importedId?: string };

export type UpstreamModel = { id: string; displayName: string | null; contextWindow: number | null };

/** 界面上显示的模型名：有显示名用显示名，否则用 id。 */
export function modelLabel(profile: Pick<UpstreamProfile, "modelNames">, id: string): string {
  return profile.modelNames?.[id] || id;
}

/** Claude 本地服务的设置（与 core `ClaudeLocalSettings` 一致，只列界面用到的）。 */
export type ClaudeConfig = {
  enabled: boolean;
  model: string;
  localization: boolean;
  voiceInput: boolean;
  computerUse: boolean;
  backgroundMode: boolean;
  /** 无视 Claude 对后台模式的 macOS 版本上限。 */
  forceBackgroundMode?: boolean;
  /** 打开 Cowork 的总开关（默认开）。 */
  cowork?: boolean;
  /** 用 Claude 的合并式主页：对话和 Cowork 合在一起，没有「对话 | Cowork」切换（默认关）。 */
  hubHome?: boolean;
  /** 录制版用哪个录制版本（前端 build id）；空 = 最新。 */
  template?: string;
  /** 界面选「本机版」：用 Claude 自己的第三方模式启动（安装包自带的新界面，推理走本地服务；默认录制版）。 */
  threePMode?: boolean;
  displayName?: string;
  email?: string;
  plan?: string;
  sessionSync?: boolean;
  listAllModels?: boolean;
  hideUnroutedModels?: boolean;
  /** Code 页签是否和命令行共用 ~/.claude。 */
  codeShareHome?: boolean;
  /** 启动前把命令行建的会话加进 Desktop 的会话列表。 */
  importCliSessions?: boolean;
};

/** 页面扩展（与 core `extensions::ExtensionInfo` 一致）。 */
export type ExtensionInfo = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  /** 清单有问题时的原因：这样的扩展不会生效，也不能启用。 */
  error: string | null;
};

/** 扩展市场的条目（与 `market::MarketEntry` 一致）。 */
export type MarketEntry = {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** official：官方仓库里审核过的；community：作者自己的仓库，未审核。 */
  source: "official" | "community";
  repo: string;
  path: string;
  commit: string;
  url: string;
  stars?: number | null;
};

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 按语义化版本比较：a 新返回正数，旧返回负数，一样（或看不懂）返回 0。构建后缀（+…）不参与比较。 */
export function compareVersions(a: string, b: string): number {
  const left = SEMVER.exec(a);
  const right = SEMVER.exec(b);
  if (!left || !right) return 0;
  for (let index = 1; index <= 3; index++) {
    const diff = Number(left[index]) - Number(right[index]);
    if (diff) return Math.sign(diff);
  }
  const [pa, pb] = [left[4], right[4]];
  if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1; // 正式版比预发布新
  const xs = pa.split(".");
  const ys = pb.split(".");
  for (let index = 0; index < Math.max(xs.length, ys.length); index++) {
    const [x, y] = [xs[index], ys[index]];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const [nx, ny] = [/^\d+$/.test(x), /^\d+$/.test(y)];
    if (nx && ny && Number(x) !== Number(y)) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type ClaudeStatus = {
  supported: boolean;
  sourceApp: string;
  version: string;
  claudeRunning: boolean;
  running: boolean;
  localProcess?: boolean;
  connected: boolean;
  port?: number | null;
  caReady: boolean;
  caTrusted: boolean;
  caMachineSupported: boolean;
  caMachineTrusted: boolean;
  /** 内嵌的录制版本，新的在前。builtAt 是该版本前端的构建时间（秒）。 */
  templates?: Array<{ build: string; builtAt: number | null }>;
  nodeAvailable: boolean;
  dictationReady: boolean;
  config: ClaudeConfig;
  models: string[];
  contextWindow?: number | null;
  warning?: string | null;
  needsRestart: boolean;
};

export const SOURCE_LABELS: Record<string, string> = {
  manual: "手动",
  ccswitch: "cc-switch",
  magpie: "Magpie",
  codexpp: "Codex++",
  "yclaude-web": "网页",
};

export const GATEWAY_URL = "https://yueziyue.uk";

export function emptyProfile(): UpstreamProfile {
  return { id: "", name: "", baseUrl: GATEWAY_URL, apiKey: "", model: "", smallModel: "", models: [], contextWindow: null, modelNames: {}, source: "manual", sourceId: "" };
}

/** 表单校验：返回第一条问题，没有问题返回 null。 */
export function profileProblem(profile: UpstreamProfile): string | null {
  if (!/^[!-~]+$/.test(profile.apiKey.trim())) return "请输入有效的 API Key";
  if (!profile.model.trim()) return "选一个默认模型";
  return null;
}

/** 列表去重、去空白，默认模型排第一。 */
export function normalizeModels(models: string[], primary = ""): string[] {
  const out: string[] = [];
  for (const raw of [primary, ...models]) {
    const model = raw.trim();
    if (model && !out.includes(model)) out.push(model);
  }
  return out;
}

export type Tone = "ok" | "warn" | "off" | "busy";

/** 顶部状态条：一句话 + 色调。 */
export function claudeState(status: ClaudeStatus | null, busy: string | null): { text: string; tone: Tone } {
  if (busy === "launch") return { text: "正在启动…", tone: "busy" };
  if (busy === "stop") return { text: "正在停止…", tone: "busy" };
  if (!status) return { text: "正在检测 Claude…", tone: "busy" };
  if (!status.supported) return { text: "没有找到 Claude Desktop", tone: "warn" };
  if (status.connected) return { text: "已连接", tone: "ok" };
  if (status.claudeRunning && status.localProcess) return { text: "运行中", tone: "ok" };
  if (status.claudeRunning) return { text: "Claude 已打开，但没有经 YClaude 启动", tone: "warn" };
  if (status.running) return { text: "本地服务已就绪", tone: "ok" };
  return { text: "未启动", tone: "off" };
}

/** 启动前还差什么：按顺序列出，界面逐条给按钮。 */
export function setupSteps(status: ClaudeStatus | null, active: UpstreamProfile | null): Array<{ id: "upstream" | "node" | "trust"; text: string }> {
  if (!status || !status.supported) return [];
  const steps: Array<{ id: "upstream" | "node" | "trust"; text: string }> = [];
  if (!active) steps.push({ id: "upstream", text: "尚未导入分组" });
  else if (profileProblem(active)) steps.push({ id: "upstream", text: `当前分组：${profileProblem(active)}` });
  if (!status.nodeAvailable) steps.push({ id: "node", text: "需要 Node.js（支持 fetch 与 WebSocket 的版本）" });
  // 第三方模式下 Claude 不经代理，不需要信任本地证书。
  if (!status.caTrusted && !status.config.threePMode) steps.push({ id: "trust", text: "首次使用需要信任本地证书" });
  return steps;
}

export const WINDOW_PRESETS: Array<{ value: number | null; label: string }> = [
  { value: null, label: "不声明（200k）" },
  { value: 200_000, label: "200k" },
  { value: 400_000, label: "400k" },
  { value: 1_000_000, label: "1M" },
];

export function formatWindow(value: number | null | undefined): string {
  if (!value) return "200k";
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1000)}k`;
}

export function isOk(result: { status: CommandStatus }): boolean {
  return result.status === "ok";
}

/** 录制版本的显示：前端构建日期 + build id，例如「2026-11-14 · a4ced7f85b」。 */
export function templateLabel(template: { build: string; builtAt: number | null }): string {
  if (!template.builtAt) return template.build;
  const date = new Date(template.builtAt * 1000);
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `${day} · ${template.build}`;
}
