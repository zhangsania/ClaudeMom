import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { Check, Download, Eye, EyeOff, FolderOpen, Loader2, PackagePlus, Play, Puzzle, RefreshCw, ShieldCheck, Square, Star, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { GATEWAY_URL, SOURCE_LABELS, WINDOW_PRESETS, claudeState, compareVersions, formatWindow, isOk, modelLabel, normalizeModels, profileProblem, setupSteps, type ClaudeStatus, type CommandResult, type ExtensionInfo, type MarketEntry, type UpstreamBook, type UpstreamModel, type UpstreamProfile } from "./model";
import { checkForUpdate, currentVersion, installUpdate, type UpdateState } from "./updates";

type Notice = { text: string; tone: "ok" | "error" } | null;
type ClaudeAction = "launch" | "stop" | "trust";
type DesktopDownload = "win32-x64" | "darwin-arm64";
type GroupMenu = { profile: UpstreamProfile; trigger: HTMLButtonElement; x: number; y: number };
type KeyImport = { id?: string; message: string; success: boolean };

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function ClaudeMomApp() {
  const [book, setBook] = useState<UpstreamBook>({ profiles: [], activeId: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<UpstreamProfile | null>(null);
  const [showExtensions, setShowExtensions] = useState(false);
  const [status, setStatus] = useState<ClaudeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null);
  const pending = useRef(false);
  const keyFileInput = useRef<HTMLInputElement>(null);
  const menuItem = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!groupMenu) return;
    menuItem.current?.focus();
    const close = () => setGroupMenu(null);
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuItem.current?.parentElement?.contains(event.target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.preventDefault();
      groupMenu.trigger.focus();
      close();
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [groupMenu]);

  const say = (text: string, tone: "ok" | "error" = "ok") => setNotice(text ? { text, tone } : null);
  // 提示过一会儿自己消失：成功的 5 秒，出错的 12 秒。
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), notice.tone === "error" ? 12000 : 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateState>({ phase: "idle" });

  // 启动时静默查一次更新：只在有新版本时提示，查不到（离线、限流）不打扰。
  useEffect(() => {
    void currentVersion().then(setVersion);
    const timer = setTimeout(() => {
      void checkForUpdate().then((result) => {
        if (result.phase === "available") setUpdate(result);
      });
    }, 5000);
    return () => clearTimeout(timer);
  }, []);

  const runUpdateCheck = async () => {
    setUpdate({ phase: "checking" });
    const result = await checkForUpdate();
    setUpdate(result);
    if (result.phase === "failed") say(`检查更新失败：${result.message}`, "error");
  };

  const runInstall = async () => {
    if (update.phase !== "available") return;
    const { update: pending, version: target } = update;
    setUpdate({ phase: "downloading", version: target, percent: null });
    try {
      await installUpdate(pending, (percent) => setUpdate({ phase: "downloading", version: target, percent }));
    } catch (cause) {
      setUpdate({ phase: "failed", message: errorText(cause) });
      say(`更新失败：${errorText(cause)}`, "error");
    }
  };

  const openDesktopDownload = async (platform: DesktopDownload) => {
    try {
      await invoke("open_desktop_download", { platform });
    } catch (cause) {
      say(`打开下载链接失败：${errorText(cause)}`, "error");
    }
  };

  const acceptBook = useCallback((result: CommandResult<UpstreamBook>, keepSelection?: string | null, keepDraft = false) => {
    const next = { profiles: result.profiles ?? [], activeId: result.activeId ?? null };
    setBook(next);
    const wanted = keepSelection ?? result.importedId ?? null;
    const target = next.profiles.find((profile) => profile.id === wanted) ?? next.profiles.find((profile) => profile.id === next.activeId) ?? next.profiles[0] ?? null;
    setSelectedId(target?.id ?? null);
    setDraft((current) => keepDraft && current && current.id === target?.id ? current : target ? { ...target } : null);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const result = await invoke<CommandResult<ClaudeStatus>>("claude_local_status");
      if (isOk(result)) setStatus(result);
      else say(result.message, "error");
    } catch (cause) {
      say(errorText(cause), "error");
    }
  }, []);

  // 先读分组，再检测 Claude 状态。
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let loadRevision = 0;
    const load = async (id?: string) => {
      const revision = ++loadRevision;
      try {
        const result = await invoke<CommandResult<UpstreamBook>>("claude_mom_load");
        if (disposed || revision !== loadRevision) return;
        acceptBook(result, id);
        if (!isOk(result)) say(result.message, "error");
      } catch (cause) {
        if (!disposed && revision === loadRevision) say(errorText(cause), "error");
      }
      if (!disposed && revision === loadRevision) await refreshStatus();
    };
    void (async () => {
      try {
        unlisten = await listen<KeyImport>("yclaude-key-imported", ({ payload }) => {
          if (disposed) return;
          say(payload.message, payload.success ? "ok" : "error");
          if (payload.success) void load(payload.id);
        });
      } catch (cause) {
        if (!disposed) say(errorText(cause), "error");
      }
      if (disposed) unlisten?.();
      else await load();
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [acceptBook, refreshStatus]);

  // Claude 开着或本地服务在跑时每 3 秒刷新一次状态；闲着不轮询（检测要查进程和证书）。
  useEffect(() => {
    if ((!status?.running && !status?.claudeRunning) || busy) return;
    const timer = setInterval(() => void refreshStatus(), 3000);
    return () => clearInterval(timer);
  }, [status?.running, status?.claudeRunning, busy, refreshStatus]);

  /** 同一时间只做一件事；结束后刷新状态。 */
  const run = async <T,>(label: string, task: () => Promise<T>): Promise<T | undefined> => {
    if (pending.current) return undefined;
    pending.current = true;
    setBusy(label);
    try {
      return await task();
    } catch (cause) {
      say(errorText(cause), "error");
      return undefined;
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  const claudeAction = (action: ClaudeAction) =>
    run(action, async () => {
      const result = await invoke<CommandResult<ClaudeStatus>>("claude_local_action", { action });
      if (isOk(result)) setStatus(result);
      say(result.message, isOk(result) ? "ok" : "error");
    });

  const bookCall = (label: string, command: string, args: Record<string, unknown>, keep?: string | null) =>
    run(label, async () => {
      const result = await invoke<CommandResult<UpstreamBook>>(command, args);
      if (isOk(result)) acceptBook(result, keep);
      say(result.message, isOk(result) ? "ok" : "error");
      await refreshStatus();
      return result;
    });

  const active = book.profiles.find((profile) => profile.id === book.activeId) ?? null;
  const dirty = useMemo(() => {
    if (!draft) return false;
    const saved = book.profiles.find((profile) => profile.id === draft.id);
    return !saved || JSON.stringify(saved) !== JSON.stringify(draft);
  }, [book, draft]);

  const select = (id: string) => {
    const profile = book.profiles.find((item) => item.id === id);
    if (!profile) return;
    setSelectedId(id);
    setDraft({ ...profile });
    setShowExtensions(false);
  };

  const showGroupMenu = (profile: UpstreamProfile, trigger: HTMLButtonElement, x: number, y: number) => {
    if (!pending.current) setGroupMenu({ profile, trigger, x, y });
  };

  const deleteProfile = (profile: UpstreamProfile) =>
    run("delete", async () => {
      const confirmed = await ask(`删除「${profile.name}」？`, {
        title: "删除分组", kind: "warning", okLabel: "删除", cancelLabel: "取消",
      });
      if (!confirmed) return;
      const result = await invoke<CommandResult<UpstreamBook>>("claude_mom_delete_profile", { id: profile.id });
      if (isOk(result)) acceptBook(result, selectedId, selectedId !== profile.id);
      say(result.message, isOk(result) ? "ok" : "error");
      await refreshStatus();
    });

  const importKey = (file: File) =>
    run("import", async () => {
      if (file.size > 16 * 1024) return say("导出文件太大", "error");
      const content = await file.text();
      const result = await invoke<CommandResult<UpstreamBook>>("claude_mom_import_web_key", { content });
      if (isOk(result)) {
        acceptBook(result);
        await refreshStatus();
      }
      say(result.message, isOk(result) ? "ok" : "error");
    });

  const saveDraft = async (activate: boolean) => {
    if (!draft) return;
    const problem = profileProblem(draft);
    if (problem) return say(problem, "error");
    const profile = { ...draft, models: normalizeModels(draft.models, draft.model) };
    await bookCall("save", "claude_mom_save_profile", { profile, activate }, draft.id);
  };

  const fetchModels = () =>
    run("models", async () => {
      if (!draft) return;
      const result = await invoke<CommandResult<{ models: UpstreamModel[] }>>("claude_mom_fetch_models", { apiKey: draft.apiKey });
      if (!isOk(result)) return say(result.message, "error");
      const ids = result.models.map((model) => model.id);
      setDraft((current) => {
        if (!current || current.id !== draft.id || current.apiKey !== draft.apiKey) return current;
        const model = current.model || ids[0] || "";
        const window = result.models.find((item) => item.id === model)?.contextWindow ?? current.contextWindow;
        const names = Object.fromEntries(result.models.filter((item) => item.displayName).map((item) => [item.id, item.displayName as string]));
        return { ...current, models: normalizeModels(ids, model), model, contextWindow: window ?? null, modelNames: { ...current.modelNames, ...names } };
      });
      say(result.message);
    });

  const state = claudeState(status, busy === "launch" || busy === "stop" ? busy : null);
  const steps = setupSteps(status, active);
  const canLaunch = Boolean(status?.supported && status.nodeAvailable && (status.caTrusted || status.config.threePMode) && active && !profileProblem(active));
  const showStop = Boolean(status?.running || status?.localProcess);

  return (
    <div className="cm-shell">
      <aside className="cm-side">
        <div className="cm-side-head" data-tauri-drag-region>
          <span className="cm-brand">YClaude</span>
        </div>
        <div className="cm-side-label">分组</div>
        <nav className="cm-list" aria-label="分组">
          {book.profiles.map((profile) => (
            <button
              aria-current={profile.id === selectedId ? "true" : undefined}
              className="cm-item"
              key={profile.id}
              onClick={() => select(profile.id)}
              onContextMenu={(event) => {
                event.preventDefault();
                showGroupMenu(profile, event.currentTarget, event.clientX, event.clientY);
              }}
              onDoubleClick={() => { if (!profileProblem(profile)) void bookCall("activate", "claude_mom_set_active", { id: profile.id }, profile.id); }}
              onKeyDown={(event) => {
                if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                showGroupMenu(profile, event.currentTarget, rect.left, rect.bottom);
              }}
              title="双击设为当前，右键打开菜单"
              type="button"
            >
              <span className="cm-radio" data-on={profile.id === book.activeId || undefined} />
              <span className="cm-item-text">
                <span className="cm-item-name">{profile.name}</span>
                <span className="cm-item-sub">{profile.model ? modelLabel(profile, profile.model) : "未选模型"}</span>
              </span>
              {profile.source !== "manual" && profile.source !== "ccswitch" ? <span className="cm-tag">{SOURCE_LABELS[profile.source] ?? profile.source}</span> : null}
            </button>
          ))}
          {!book.profiles.length && !draft ? <p className="cm-empty">暂无分组</p> : null}
        </nav>
        {groupMenu ? (
          <div aria-label={groupMenu.profile.name} className="cm-menu cm-group-menu" role="menu"
            style={{
              left: `clamp(0px, ${groupMenu.x}px, calc(100vw - 136px))`,
              top: `clamp(0px, ${groupMenu.y}px, calc(100vh - 40px))`,
            }}
          >
            <button className="cm-btn-danger" ref={menuItem} role="menuitem" type="button" onClick={() => {
              setGroupMenu(null);
              groupMenu.trigger.focus();
              void deleteProfile(groupMenu.profile);
            }}>
              <Trash2 aria-hidden="true" />删除分组
            </button>
          </div>
        ) : null}
        <footer className="cm-side-foot">
          <div className="cm-about">
            <span>{version ? `YClaude ${version}` : "YClaude"}</span>
            {update.phase === "available" ? (
              <button className="cm-link" onClick={() => void runInstall()} type="button">更新到 {update.version}</button>
            ) : update.phase === "downloading" ? (
              <span role="status">正在更新{update.percent != null ? ` · ${update.percent}%` : "…"}</span>
            ) : (
              <button className="cm-link" disabled={update.phase === "checking"} onClick={() => void runUpdateCheck()} type="button">
                {update.phase === "checking" ? "检查中…" : update.phase === "latest" ? "已是最新" : "检查更新"}
              </button>
            )}
          </div>
          <div className="cm-desktop-downloads" role="group" aria-label="Claude Desktop 5.11492.5 下载">
            <span className="cm-desktop-download-title">Claude Desktop 5.11492.5</span>
            <button className="cm-link" onClick={() => void openDesktopDownload("win32-x64")} title="下载 Windows x64 官方独立包（.nupkg）" type="button">
              <Download aria-hidden="true" />Windows x64
            </button>
            <button className="cm-link" onClick={() => void openDesktopDownload("darwin-arm64")} title="下载 Mac Apple Silicon 官方独立包（.zip）" type="button">
              <Download aria-hidden="true" />Mac Apple Silicon
            </button>
          </div>
        </footer>
      </aside>

      <main className="cm-main">
        <header className="cm-toolbar" data-tauri-drag-region>
          <span className="cm-dot" data-tone={state.tone} />
          <div className="cm-toolbar-text" data-tauri-drag-region>
            <strong>{state.text}</strong>
            <span>
              {!status?.supported && status ? "需要先安装官方 Claude Desktop" : active ? `${active.name} · ${active.model ? modelLabel(active, active.model) : "未选模型"}` : "暂无分组"}
            </span>
          </div>
          <div className="cm-toolbar-actions">
            <button aria-label={showExtensions ? "返回分组" : "扩展"} aria-pressed={showExtensions} className="cm-icon" onClick={() => setShowExtensions((shown) => !shown)} title={showExtensions ? "返回分组" : "扩展"} type="button">
              <Puzzle />
            </button>
            <input
              accept=".json"
              hidden
              ref={keyFileInput}
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) void importKey(file);
              }}
            />
            <button aria-label="打开 Key 文件" className="cm-icon" disabled={busy !== null} onClick={() => keyFileInput.current?.click()} title="打开网页导出的 YClaude Key 文件" type="button">
              {busy === "import" ? <Loader2 className="cm-spin" /> : <Download />}
            </button>
            <button aria-label="重新检测" className="cm-icon" disabled={busy !== null} onClick={() => void run("detect", refreshStatus)} title="重新检测" type="button">
              <RefreshCw className={busy === "detect" ? "cm-spin" : undefined} />
            </button>
            {showStop ? (
              <button className="cm-btn" disabled={busy !== null} onClick={() => void claudeAction("stop")} type="button"><Square />停止</button>
            ) : null}
            <button className="cm-btn cm-btn-primary" disabled={busy !== null || !canLaunch || Boolean(status?.claudeRunning)} onClick={() => void claudeAction("launch")} title={status?.claudeRunning ? "先完全退出 Claude 再启动" : undefined} type="button">
              {busy === "launch" ? <Loader2 className="cm-spin" /> : <Play />}启动 Claude
            </button>
          </div>
        </header>

        {steps.length || status?.needsRestart || status?.warning ? (
          <div className="cm-banners">
            {steps.map((step) => (
              <div className="cm-banner" key={step.id}>
                <span>{step.text}</span>
                {step.id === "trust" ? (
                  <button className="cm-btn cm-btn-small" disabled={busy !== null} onClick={() => void claudeAction("trust")} type="button"><ShieldCheck />信任证书</button>
                ) : null}
              </div>
            ))}
            {status?.needsRestart ? <div className="cm-banner" data-tone="info"><span>设置变了：完全退出 Claude 后重新启动生效。</span></div> : null}
            {status?.warning && !steps.length ? <div className="cm-banner"><span>{status.warning}</span></div> : null}
          </div>
        ) : null}

        <section className="cm-body">
          {showExtensions ? (
            <Extensions threePMode={false} onNotice={say} />
          ) : draft ? (
            <UpstreamEditor
              active={draft.id === book.activeId}
              busy={busy}
              dirty={dirty}
              draft={draft}
              key={draft.id}
              onActivate={() => void bookCall("activate", "claude_mom_set_active", { id: draft.id }, draft.id)}
              onChange={setDraft}
              onDelete={() => void deleteProfile(draft)}
              onDiscard={() => {
                const saved = book.profiles.find((profile) => profile.id === draft.id);
                if (saved) setDraft({ ...saved });
              }}
              onFetchModels={() => void fetchModels()}
              onSave={(activate) => void saveDraft(activate)}
            />
          ) : (
            <div className="cm-placeholder">
              <button className="cm-btn" disabled={busy !== null} onClick={() => keyFileInput.current?.click()} type="button"><Download />打开 Key 文件</button>
            </div>
          )}
        </section>

        <footer className="cm-status">
          <span>{status?.port ? `本地服务 · 端口 ${status.port}` : "本地服务未运行"}</span>
          {notice ? (
            <span className="cm-notice" data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
              {notice.text}
              <button aria-label="关闭提示" onClick={() => setNotice(null)} type="button"><X /></button>
            </span>
          ) : null}
        </footer>
      </main>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="cm-field">
      <span className="cm-field-label">{label}</span>
      <span className="cm-field-control">{children}</span>
      {hint ? <span className="cm-field-hint">{hint}</span> : null}
    </label>
  );
}

function PageHead({ title, hint, children }: { title: string; hint: string; children?: ReactNode }) {
  return (
    <header className="cm-page-head">
      <div className="cm-grow">
        <h2>{title}<span className="cm-tag">所有上游通用</span></h2>
        <p className="cm-field-hint">{hint}</p>
      </div>
      {children}
    </header>
  );
}

type ExtensionsResult = CommandResult<{ extensions: ExtensionInfo[] }>;
type MarketResult = CommandResult<{ entries: MarketEntry[] }>;
const MARKET_REPO_URL = "https://github.com/BigPizzaV3/claude-mom-extensions";

/** 页面扩展：注入 Claude 页面的 js / css 包，本地导入或从市场装。开关、安装、删除都是刷新 Claude 页面就生效。 */
function Extensions({ threePMode, onNotice }: { threePMode: boolean; onNotice: (text: string, tone?: "ok" | "error") => void }) {
  const [items, setItems] = useState<ExtensionInfo[] | null>(null);
  const [market, setMarket] = useState<MarketEntry[] | null>(null);
  const [marketError, setMarketError] = useState<string | null>(null);
  const [view, setView] = useState<"installed" | "market">("installed");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const call = async (label: string, command: string, args: Record<string, unknown> = {}) => {
    setBusy(label);
    try {
      const result = await invoke<ExtensionsResult>(command, args);
      setItems(result.extensions ?? []);
      if (result.message) onNotice(result.message, isOk(result) ? "ok" : "error");
    } catch (cause) {
      onNotice(errorText(cause), "error");
    } finally {
      setBusy(null);
    }
  };

  const loadMarket = useCallback(async () => {
    setMarketError(null);
    try {
      const result = await invoke<MarketResult>("claude_local_extension_market");
      if (isOk(result)) setMarket(result.entries);
      else setMarketError(result.message);
    } catch (cause) {
      setMarketError(errorText(cause));
    }
  }, []);

  useEffect(() => {
    void invoke<ExtensionsResult>("claude_local_extensions")
      .then((result) => setItems(result.extensions ?? []))
      .catch((cause) => onNotice(errorText(cause), "error"));
    // 市场也顺手读一次：已安装的扩展据此提示更新；读不到只在市场页里说。
    void loadMarket();
    // 只在打开这一页时读一次；之后每个操作都会带回最新列表。
  }, []);

  const importPackage = async () => {
    const path = await open({
      directory: false,
      multiple: false,
      title: "选择扩展包的 .zip，或扩展文件夹里的 manifest.json",
      filters: [{ name: "扩展包", extensions: ["zip", "json"] }],
    });
    if (typeof path === "string") await call("import", "claude_local_extension_import", { path });
  };

  const remove = async (item: ExtensionInfo) => {
    const yes = await ask(`删除「${item.name}」？扩展文件夹会一起删掉。`, { title: "删除扩展", kind: "warning", okLabel: "删除", cancelLabel: "取消" });
    if (yes) await call(`remove:${item.id}`, "claude_local_extension_remove", { id: item.id });
  };

  const install = async (entry: MarketEntry, update: boolean) => {
    if (entry.source === "community" && !update) {
      const yes = await ask(
        `「${entry.name}」来自 ${entry.repo}，没有经过官方审核。\n\n扩展运行在 Claude 页面里，能读到页面上的一切，包括对话内容。确定安装？`,
        { title: "安装社区扩展", kind: "warning", okLabel: "安装", cancelLabel: "取消" },
      );
      if (!yes) return;
    }
    await call(`install:${entry.id}`, "claude_local_extension_install", { entry });
  };

  const openPage = (url: string) =>
    void invoke<CommandResult<object>>("claude_local_extension_open_page", { url }).then((result) => {
      if (!isOk(result)) onNotice(result.message, "error");
    });

  if (!items) return <div className="cm-placeholder"><Loader2 className="cm-spin" /></div>;
  const installed = new Map(items.map((item) => [item.id, item]));
  const updates = new Map((market ?? [])
    .filter((entry) => {
      const local = installed.get(entry.id);
      return local && !local.builtin && compareVersions(entry.version, local.version) > 0;
    })
    .map((entry) => [entry.id, entry]));
  const needle = query.trim().toLowerCase();
  const shown = (market ?? []).filter((entry) => !needle || [entry.name, entry.id, entry.author, entry.description, entry.repo].some((text) => text.toLowerCase().includes(needle)));

  return (
    <div className="cm-settings">
      <PageHead hint="注入 Claude 页面的脚本和样式。开关、安装、删除后刷新 Claude 页面（Cmd/Ctrl+R）生效。" title="扩展">
        <button className="cm-btn" disabled={busy !== null} onClick={() => void call("open", "claude_local_extension_open_folder")} type="button"><FolderOpen />打开文件夹</button>
        <button className="cm-btn" disabled={busy !== null} onClick={() => void importPackage()} type="button">
          {busy === "import" ? <Loader2 className="cm-spin" /> : <PackagePlus />}导入扩展包
        </button>
      </PageHead>
      {threePMode ? <p className="cm-warn-text">当前是本机版界面：它不经本地服务，扩展不会生效。换回录制版界面后可用。</p> : null}
      <div className="cm-card-line">
        <div className="cm-seg" role="tablist">
          <button aria-selected={view === "installed"} onClick={() => setView("installed")} role="tab" type="button">
            已安装<span className="cm-seg-count">{items.length}</span>
          </button>
          <button aria-selected={view === "market"} onClick={() => setView("market")} role="tab" type="button">
            市场{updates.size ? <span className="cm-seg-count" data-tone="accent">{updates.size} 个更新</span> : null}
          </button>
        </div>
        <span className="cm-spacer" />
        {view === "market" ? (
          <>
            <input aria-label="搜索扩展" className="cm-search" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索名称、作者、说明" value={query} />
            <button aria-label="刷新市场" className="cm-icon" disabled={busy !== null} onClick={() => { setMarket(null); void loadMarket(); }} title="刷新市场" type="button">
              <RefreshCw className={market === null && !marketError ? "cm-spin" : undefined} />
            </button>
          </>
        ) : null}
      </div>

      {view === "installed" ? (
        <>
          <p className="cm-field-hint">扩展在官方脚本之前运行，能读到页面里的一切（包括对话内容）。只装自己写的或信得过的。</p>
          {items.map((item) => {
            const update = updates.get(item.id);
            return (
              <section className="cm-card" key={item.id}>
                <label className="cm-toggle-row">
                  <span className="cm-toggle-text">
                    <span className="cm-card-line">
                      <strong className="cm-ext-name">{item.name}</strong>
                      {item.version ? <span className="cm-tag cm-mono">v{item.version}</span> : null}
                      {item.builtin ? <span className="cm-tag">内置</span> : null}
                    </span>
                    {item.error
                      ? <span className="cm-warn-text cm-ext-desc">清单有问题：{item.error}</span>
                      : <span className="cm-field-hint cm-ext-desc">{item.description || "没有说明"}</span>}
                  </span>
                  <input
                    checked={item.enabled}
                    disabled={busy !== null || (Boolean(item.error) && !item.enabled)}
                    onChange={(event) => void call(`enable:${item.id}`, "claude_local_extension_enable", { id: item.id, enabled: event.currentTarget.checked })}
                    type="checkbox"
                  />
                  <span aria-hidden="true" className="cm-switch" />
                </label>
                <div className="cm-card-line cm-field-hint">
                  <span className="cm-mono">{item.id}</span>
                  {item.author ? <span>· {item.author}</span> : null}
                  <span className="cm-spacer" />
                  {update ? (
                    <button className="cm-btn cm-btn-small cm-btn-primary" disabled={busy !== null} onClick={() => void install(update, true)} type="button">
                      {busy === `install:${item.id}` ? <Loader2 className="cm-spin" /> : <Download />}更新到 {update.version}
                    </button>
                  ) : null}
                  {item.builtin ? null : (
                    <button className="cm-btn cm-btn-small cm-btn-danger" disabled={busy !== null} onClick={() => void remove(item)} type="button"><Trash2 />删除</button>
                  )}
                </div>
              </section>
            );
          })}
          <p className="cm-field-hint">
            扩展包是一个文件夹：manifest.json 写 id、name、version、author、description，以及要注入的 scripts（.js）和 styles（.css）。可以直接导入文件夹里的 manifest.json，或把文件夹打成 .zip 导入。
          </p>
        </>
      ) : (
        <>
          {marketError ? (
            <div className="cm-card">
              <span className="cm-warn-text">{marketError}</span>
              <div className="cm-row-actions"><button className="cm-btn cm-btn-small" onClick={() => void loadMarket()} type="button"><RefreshCw />重试</button></div>
            </div>
          ) : market === null ? (
            <div className="cm-placeholder cm-market-loading"><Loader2 className="cm-spin" /></div>
          ) : !shown.length ? (
            <p className="cm-field-hint">{needle ? "没有找到匹配的扩展。" : "市场里还没有扩展。"}</p>
          ) : (
            shown.map((entry) => {
              const local = installed.get(entry.id);
              const label = `install:${entry.id}`;
              return (
                <section className="cm-card" key={`${entry.repo}/${entry.id}`}>
                  <div className="cm-card-line">
                    <strong className="cm-ext-name">{entry.name}</strong>
                    <span className="cm-tag cm-mono">v{entry.version}</span>
                    {entry.source === "official"
                      ? <span className="cm-tag" data-tone="ok"><ShieldCheck />官方审核</span>
                      : <span className="cm-tag">社区</span>}
                    {entry.source === "community" && entry.stars ? <span className="cm-field-hint"><Star className="cm-star" />{entry.stars}</span> : null}
                    <span className="cm-spacer" />
                    {local?.builtin ? (
                      <span className="cm-tag">已内置</span>
                    ) : updates.has(entry.id) ? (
                      <button className="cm-btn cm-btn-small cm-btn-primary" disabled={busy !== null} onClick={() => void install(entry, true)} type="button">
                        {busy === label ? <Loader2 className="cm-spin" /> : <Download />}更新到 {entry.version}
                      </button>
                    ) : local ? (
                      <span className="cm-tag" data-tone="ok"><Check />已安装</span>
                    ) : (
                      <button className="cm-btn cm-btn-small cm-btn-primary" disabled={busy !== null} onClick={() => void install(entry, false)} type="button">
                        {busy === label ? <Loader2 className="cm-spin" /> : <Download />}安装
                      </button>
                    )}
                  </div>
                  <span className="cm-field-hint cm-ext-desc">{entry.description || "没有说明"}</span>
                  <div className="cm-card-line cm-field-hint">
                    <span className="cm-mono">{entry.id}</span>
                    {entry.author ? <span>· {entry.author}</span> : null}
                    <span className="cm-spacer" />
                    <button className="cm-link" onClick={() => openPage(entry.url)} title={entry.url} type="button">{entry.repo}</button>
                  </div>
                </section>
              );
            })
          )}
          <p className="cm-field-hint">
            「官方审核」的扩展收在 claude-mom-extensions 仓库里，合并前看过代码；「社区」扩展来自作者自己的仓库，没人审核过。
            想上架自己的扩展？<button className="cm-link" onClick={() => openPage(MARKET_REPO_URL)} type="button">看看怎么做</button>
          </p>
        </>
      )}
    </div>
  );
}

function UpstreamEditor({ draft, active, dirty, busy, onChange, onSave, onActivate, onDelete, onDiscard, onFetchModels }: {
  draft: UpstreamProfile;
  active: boolean;
  dirty: boolean;
  busy: string | null;
  onChange: (next: UpstreamProfile) => void;
  onSave: (activate: boolean) => void;
  onActivate: () => void;
  onDelete: () => void;
  onDiscard: () => void;
  onFetchModels: () => void;
}) {
  const [showKey, setShowKey] = useState(false);
  const [newModel, setNewModel] = useState("");
  // 地址和 Key 填好以后很少改：默认收成一行，新建或没填时才展开。
  const [editConnection, setEditConnection] = useState(!draft.id || !draft.baseUrl);
  useEffect(() => setEditConnection(!draft.id || !draft.baseUrl), [draft.id]);
  const set = (patch: Partial<UpstreamProfile>) => onChange({ ...draft, ...patch });
  const preset = WINDOW_PRESETS.find((item) => item.value === draft.contextWindow);
  const options = draft.model && !draft.models.includes(draft.model) ? [draft.model, ...draft.models] : draft.models;
  const addModel = () => {
    const model = newModel.trim();
    if (!model) return;
    set({ models: normalizeModels([...draft.models, model]), model: draft.model || model });
    setNewModel("");
  };
  return (
    <div className="cm-editor">
      <div className="cm-editor-head">
        <input aria-label="分组名称" className="cm-title-input" onChange={(event) => set({ name: event.currentTarget.value })} placeholder="分组名称" value={draft.name} />
        {active ? <span className="cm-tag" data-tone="ok"><Check />使用中</span> : null}
      </div>

      <section className="cm-card">
        <div className="cm-card-label">连接</div>
        {editConnection ? (
          <div className="cm-form">
            <Field label="Base URL">
              <span className="cm-mono">{GATEWAY_URL}</span>
            </Field>
            <Field label="Key">
              <input autoComplete="off" onChange={(event) => set({ apiKey: event.currentTarget.value })} placeholder="sk-…" spellCheck={false} type={showKey ? "text" : "password"} value={draft.apiKey} />
              <button aria-label={showKey ? "隐藏 Key" : "显示 Key"} className="cm-icon" onClick={() => setShowKey((value) => !value)} type="button">{showKey ? <EyeOff /> : <Eye />}</button>
            </Field>
          </div>
        ) : (
          <div className="cm-card-line">
            <span className="cm-mono cm-ellipsis" title={GATEWAY_URL}>{GATEWAY_URL}</span>
            {draft.source !== "manual" && draft.source !== "ccswitch" ? <span className="cm-tag">来自 {SOURCE_LABELS[draft.source] ?? draft.source}</span> : null}
            <button className="cm-link" onClick={() => setEditConnection(true)} type="button">修改</button>
          </div>
        )}
      </section>

      <section className="cm-card">
        <div className="cm-card-label">模型</div>
        <div className="cm-card-line">
          {options.length ? (
            <select aria-label="默认模型" className="cm-grow" onChange={(event) => set({ model: event.currentTarget.value })} value={draft.model}>
              {!draft.model ? <option value="">选一个默认模型</option> : null}
              {options.map((model) => <option key={model} value={model}>{modelLabel(draft, model)}</option>)}
            </select>
          ) : (
            <input aria-label="默认模型" className="cm-grow" onChange={(event) => set({ model: event.currentTarget.value })} placeholder="先拉取模型，或直接填模型名" spellCheck={false} value={draft.model} />
          )}
          <button aria-label="拉取模型" className="cm-icon" disabled={busy !== null || !draft.apiKey.trim()} onClick={onFetchModels} title="拉取分组模型列表" type="button">
            {busy === "models" ? <Loader2 className="cm-spin" /> : <RefreshCw />}
          </button>
        </div>
        {draft.models.length > 1 ? <p className="cm-field-hint">在 Claude 里还能切换另外 {draft.models.length - 1} 个模型。</p> : null}
      </section>

      <details className="cm-more">
        <summary>高级</summary>
        <div className="cm-form">
          <Field hint="标题生成等小任务用，留空同默认模型" label="快速模型">
            <select onChange={(event) => set({ smallModel: event.currentTarget.value })} value={draft.smallModel}>
              <option value="">同默认模型</option>
              {options.map((model) => <option key={model} value={model}>{modelLabel(draft, model)}</option>)}
            </select>
          </Field>
          <Field label="上下文窗口">
            <select onChange={(event) => set({ contextWindow: event.currentTarget.value === "" ? null : Number(event.currentTarget.value) })} value={draft.contextWindow == null ? "" : String(draft.contextWindow)}>
              {WINDOW_PRESETS.map((item) => <option key={item.label} value={item.value == null ? "" : String(item.value)}>{item.label}</option>)}
              {!preset && draft.contextWindow ? <option value={String(draft.contextWindow)}>{formatWindow(draft.contextWindow)}</option> : null}
            </select>
          </Field>
          <div className="cm-field">
            <span className="cm-field-label">可选模型</span>
            <div className="cm-chips">
              {draft.models.map((model) => (
                <span className="cm-chip" data-primary={model === draft.model || undefined} key={model}>
                  <button onClick={() => set({ model })} title={`${model}（点一下设为默认）`} type="button">{modelLabel(draft, model)}</button>
                  <button aria-label={`移除 ${model}`} onClick={() => set({ models: draft.models.filter((item) => item !== model), model: draft.model === model ? "" : draft.model })} type="button"><X /></button>
                </span>
              ))}
              <input
                aria-label="添加模型"
                className="cm-chip-input"
                onChange={(event) => setNewModel(event.currentTarget.value)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addModel(); } }}
                placeholder="添加模型，回车"
                spellCheck={false}
                value={newModel}
              />
            </div>
          </div>
          {draft.id ? (
            <div className="cm-row-actions">
              <button className="cm-btn cm-btn-small cm-btn-danger" disabled={busy !== null} onClick={onDelete} type="button"><Trash2 />删除分组</button>
            </div>
          ) : null}
        </div>
      </details>

      {dirty || (draft.id && !active) ? (
        <div className="cm-editor-foot">
          <span className="cm-spacer" />
          {dirty ? <button className="cm-btn cm-btn-quiet" disabled={busy !== null} onClick={onDiscard} type="button">放弃修改</button> : null}
          {!dirty && draft.id && !active ? <button className="cm-btn cm-btn-primary" disabled={busy !== null} onClick={onActivate} type="button">使用这组</button> : null}
          {dirty ? <button className="cm-btn" disabled={busy !== null} onClick={() => onSave(false)} type="button">保存</button> : null}
          {dirty ? <button className="cm-btn cm-btn-primary" disabled={busy !== null} onClick={() => onSave(true)} type="button">保存并使用</button> : null}
        </div>
      ) : null}
    </div>
  );
}
