//! ClaudeMom 的命令：Claude 状态 / 启动 / 设置（转给 claude-local），上游管理与导入，听写模型。

use std::sync::Mutex;

use crate::upstreams::{self as claude_mom, UpstreamBook, UpstreamModel, UpstreamProfile};
use serde::Serialize;

use serde_json::{Value, json};

/// 命令统一返回 `{status, message, ...payload}`（payload 平铺到顶层，前端按这个形状读）。
#[derive(Debug, Serialize)]
pub struct CommandResult<T: Serialize> {
    pub status: String,
    pub message: String,
    #[serde(flatten)]
    pub payload: T,
}

pub fn ok<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult { status: "ok".into(), message: message.into(), payload }
}

pub fn failed<T: Serialize>(message: &str, payload: T) -> CommandResult<T> {
    CommandResult { status: "failed".into(), message: message.into(), payload }
}

/// 读-改-写上游列表时串行，避免两次保存互相覆盖。
static BOOK_LOCK: Mutex<()> = Mutex::new(());

/// payload 必须是结构体：`CommandResult` 会把它 flatten 到顶层，数组没法 flatten。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookPayload {
    profiles: Vec<UpstreamProfile>,
    active_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    imported_id: Option<String>,
}

impl From<UpstreamBook> for BookPayload {
    fn from(book: UpstreamBook) -> Self {
        Self { profiles: book.profiles, active_id: book.active_id, imported_id: None }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct ModelsPayload {
    models: Vec<UpstreamModel>,
}

fn load() -> anyhow::Result<UpstreamBook> {
    claude_mom::load_groups()
}

/// 改上游列表并存盘，然后把选中的那组交给 Claude 本地服务。
fn mutate<T>(change: impl FnOnce(&mut UpstreamBook) -> anyhow::Result<T>) -> anyhow::Result<(UpstreamBook, T)> {
    let _guard = BOOK_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut book = load()?;
    let value = change(&mut book)?;
    claude_mom::save_book(&claude_mom::groups_path(), &book)?;
    Ok((book, value))
}

fn respond<T>(result: anyhow::Result<(UpstreamBook, T)>, message: impl FnOnce(T) -> String, failure: &str) -> CommandResult<BookPayload> {
    match result {
        Ok((book, value)) => ok(&message(value), book.into()),
        Err(error) => failed(&format!("{failure}：{error:#}"), load().unwrap_or_default().into()),
    }
}



#[tauri::command]
pub fn claude_mom_load() -> CommandResult<BookPayload> {
    match load() {
        Ok(book) => ok("已读取分组。", book.into()),
        Err(error) => failed(&format!("{error:#}"), BookPayload::default()),
    }
}

/// 新增（id 为空）或更新一组；`activate` 为真时同时设为当前。
#[tauri::command]
pub fn claude_mom_save_profile(mut profile: UpstreamProfile, activate: Option<bool>) -> CommandResult<BookPayload> {
    let result = mutate(|book| {
        anyhow::ensure!(claude_mom::is_valid_api_key(&profile.api_key), "请输入有效的 API Key");
        profile.base_url = claude_mom::GATEWAY_URL.into();
        let id = book.upsert(profile);
        if activate.unwrap_or(false) {
            book.active_id = Some(id.clone());
        }
        Ok(book.profiles.iter().find(|item| item.id == id).map(|item| item.name.clone()).unwrap_or_default())
    });
    respond(result, |name| format!("已保存「{name}」。"), "保存分组失败")
}

#[tauri::command]
pub fn claude_mom_delete_profile(id: String) -> CommandResult<BookPayload> {
    let result = mutate(|book| {
        let name = book.profiles.iter().find(|item| item.id == id).map(|item| item.name.clone()).unwrap_or_default();
        book.remove(&id);
        Ok(name)
    });
    respond(result, |name| format!("已删除「{name}」。"), "删除分组失败")
}

#[tauri::command]
pub fn claude_mom_set_active(id: String) -> CommandResult<BookPayload> {
    let result = mutate(|book| {
        let name = book
            .profiles
            .iter()
            .find(|item| item.id == id)
            .map(|item| item.name.clone())
            .ok_or_else(|| anyhow::anyhow!("分组已不存在"))?;
        book.active_id = Some(id.clone());
        Ok(name)
    });
    respond(result, |name| format!("已切换到「{name}」，重新启动 Claude 后生效。"), "切换分组失败")
}

#[tauri::command]
pub fn claude_mom_import_web_key(content: String) -> CommandResult<BookPayload> {
    let result = mutate(|book| book.import_web_key(&content));
    match result {
        Ok((book, id)) => {
            let mut payload = BookPayload::from(book);
            payload.imported_id = Some(id);
            ok("已导入分组。", payload)
        }
        Err(error) => failed(&format!("导入失败：{error:#}"), BookPayload::default()),
    }
}

#[tauri::command]
pub async fn claude_mom_fetch_models(api_key: String) -> CommandResult<ModelsPayload> {
    if !claude_mom::is_valid_api_key(&api_key) {
        return failed("请输入有效的 API Key", ModelsPayload::default());
    }
    match claude_mom::fetch_models(claude_mom::GATEWAY_URL, &api_key).await {
        Ok(models) => ok(&format!("拉到 {} 个模型。", models.len()), ModelsPayload { models }),
        Err(error) => failed(&format!("{error:#}"), ModelsPayload::default()),
    }
}

#[tauri::command]
pub async fn claude_local_status() -> CommandResult<Value> {
    match tauri::async_runtime::spawn_blocking(claude_local::status).await {
        Ok(Ok(status)) => ok("Claude 状态已读取。", serde_json::to_value(status).unwrap_or_default()),
        Ok(Err(error)) => failed(&format!("{error:#}"), json!({})),
        Err(error) => failed(&format!("Claude 状态读取失败：{error}"), json!({})),
    }
}

#[tauri::command]
pub async fn claude_local_action(action: String) -> CommandResult<Value> {
    #[cfg(target_os = "windows")]
    if action == "launch"
        && let Err(error) = crate::desktop_update::prepare_launch().await
    {
        return failed(&format!("{error:#}"), json!({}));
    }
    match tauri::async_runtime::spawn_blocking(move || claude_local::perform(&action)).await {
        Ok(Ok(result)) => ok(&result.message, serde_json::to_value(result.status).unwrap_or_default()),
        Ok(Err(error)) => {
            let status = claude_local::status().ok().and_then(|status| serde_json::to_value(status).ok());
            failed(&format!("{error:#}"), status.unwrap_or_else(|| json!({})))
        }
        Err(error) => failed(&format!("操作失败：{error}"), json!({})),
    }
}

#[tauri::command]
pub fn open_desktop_download(platform: String) -> Result<(), String> {
    let open = || -> anyhow::Result<()> {
        let url = crate::desktop_packages::download_url(&platform)?;
        #[cfg(target_os = "windows")]
        claude_local::winproc::open_in_default_browser(url.as_str())?;
        #[cfg(target_os = "macos")]
        anyhow::ensure!(
            std::process::Command::new("/usr/bin/open").arg(url.as_str()).status()?.success(),
            "无法打开系统默认浏览器"
        );
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        anyhow::bail!("当前系统不支持此下载入口：{url}");
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        Ok(())
    };
    open().map_err(|error| format!("{error:#}"))
}

// ── 页面扩展 ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ExtensionsPayload {
    extensions: Vec<claude_local::extensions::ExtensionInfo>,
}

fn extensions_payload() -> ExtensionsPayload {
    ExtensionsPayload { extensions: claude_local::extensions::list() }
}

const REFRESH_HINT: &str = "刷新 Claude 页面（Cmd/Ctrl+R）生效。";

#[tauri::command]
pub fn claude_local_extensions() -> CommandResult<ExtensionsPayload> {
    ok("", extensions_payload())
}

#[tauri::command]
pub fn claude_local_extension_enable(id: String, enabled: bool) -> CommandResult<ExtensionsPayload> {
    match claude_local::extensions::set_enabled(&id, enabled) {
        Ok(extensions) => {
            let name = extensions.iter().find(|item| item.id == id).map_or(id.as_str(), |item| item.name.as_str());
            let message = format!("已{}「{name}」，{REFRESH_HINT}", if enabled { "启用" } else { "停用" });
            ok(&message, ExtensionsPayload { extensions })
        }
        Err(error) => failed(&format!("{error:#}"), extensions_payload()),
    }
}

#[tauri::command]
pub async fn claude_local_extension_import(path: String) -> CommandResult<ExtensionsPayload> {
    let result = tauri::async_runtime::spawn_blocking(move || claude_local::extensions::import(std::path::Path::new(&path))).await;
    match result {
        Ok(Ok(imported)) => {
            let manifest = &imported.manifest;
            let message = match imported.replaced {
                Some(old) => format!("已把「{}」从 {old} 更新到 {}。{REFRESH_HINT}", manifest.name, manifest.version),
                None => format!("已导入「{}」{}，打开开关后{REFRESH_HINT}", manifest.name, manifest.version),
            };
            ok(&message, extensions_payload())
        }
        Ok(Err(error)) => failed(&format!("导入失败：{error:#}"), extensions_payload()),
        Err(error) => failed(&format!("导入失败：{error}"), extensions_payload()),
    }
}

#[tauri::command]
pub fn claude_local_extension_remove(id: String) -> CommandResult<ExtensionsPayload> {
    match claude_local::extensions::remove(&id) {
        Ok(name) => ok(&format!("已删除「{name}」，{REFRESH_HINT}"), extensions_payload()),
        Err(error) => failed(&format!("{error:#}"), extensions_payload()),
    }
}

#[tauri::command]
pub fn claude_local_extension_open_folder() -> CommandResult<ExtensionsPayload> {
    match claude_local::extensions::open_folder() {
        Ok(()) => ok("", extensions_payload()),
        Err(error) => failed(&format!("{error:#}"), extensions_payload()),
    }
}

#[derive(Debug, Serialize)]
pub struct MarketPayload {
    entries: Vec<crate::market::MarketEntry>,
}

#[tauri::command]
pub async fn claude_local_extension_market() -> CommandResult<MarketPayload> {
    match crate::market::fetch().await {
        Ok(entries) => ok("", MarketPayload { entries }),
        Err(error) => failed(&format!("{error:#}"), MarketPayload { entries: Vec::new() }),
    }
}

/// 从市场安装或更新。新装的直接启用（用户点的就是「安装」）；更新保留原来的开关。
#[tauri::command]
pub async fn claude_local_extension_install(entry: crate::market::MarketEntry) -> CommandResult<ExtensionsPayload> {
    match crate::market::install(&entry).await {
        Ok(imported) => {
            let manifest = &imported.manifest;
            let message = match imported.replaced {
                Some(old) => format!("已把「{}」从 {old} 更新到 {}。{REFRESH_HINT}", manifest.name, manifest.version),
                None => match claude_local::extensions::set_enabled(&manifest.id, true) {
                    Ok(_) => format!("已安装并启用「{}」{}，{REFRESH_HINT}", manifest.name, manifest.version),
                    Err(error) => format!("已安装「{}」，但没能启用：{error:#}", manifest.name),
                },
            };
            ok(&message, extensions_payload())
        }
        Err(error) => failed(&format!("安装「{}」失败：{error:#}", entry.name), extensions_payload()),
    }
}

/// 在浏览器里打开扩展的仓库页；只开 GitHub 上的地址。
#[tauri::command]
pub fn claude_local_extension_open_page(url: String) -> CommandResult<Value> {
    let parsed = reqwest::Url::parse(&url);
    if !parsed.is_ok_and(|parsed| parsed.scheme() == "https" && parsed.host_str() == Some("github.com")) {
        return failed("只能打开 GitHub 上的页面", json!({}));
    }
    match std::process::Command::new(if cfg!(windows) { "explorer" } else { "/usr/bin/open" }).arg(&url).spawn() {
        Ok(_) => ok("", json!({})),
        Err(error) => failed(&format!("打不开浏览器：{error}"), json!({})),
    }
}

// ── 本地听写模型 ─────────────────────────────────────────────────────────

#[tauri::command]
pub fn dictation_local_model_status() -> Value {
    claude_local::dictation::model_status()
}

#[tauri::command]
pub async fn download_dictation_local_model() -> CommandResult<Value> {
    match claude_local::dictation::prepare_model().await {
        Ok(state) => ok("本地 SenseVoice 模型下载并校验完成。", state),
        Err(error) => failed(&error.message, json!({})),
    }
}
