//! YClaude 的网页 Key 导入、分组存储和固定网关。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use claude_local::Upstream;

pub const SOURCE_MANUAL: &str = "manual";
pub const SOURCE_WEB: &str = "yclaude-web";
pub const GATEWAY_URL: &str = "https://yueziyue.uk";

const BOOK_FILE: &str = "upstreams.json";
const GROUPS_FILE: &str = "yclaude-groups.json";
pub const MAX_KEY_EXPORT_BYTES: usize = 16 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WebKeyExport {
    format: String,
    version: u32,
    key_id: String,
    group_name: String,
    api_key: String,
}

pub fn parse_web_key(content: &str) -> Result<UpstreamProfile> {
    if content.len() > MAX_KEY_EXPORT_BYTES {
        bail!("导出文件太大");
    }
    let export: WebKeyExport = serde_json::from_str(content)
        .map_err(|_| anyhow::anyhow!("请选择网页导出的 YClaude Key 文件"))?;
    let name = export.group_name.trim();
    let key = export.api_key.trim();
    if export.format != "yclaude-key" || export.version != 1 {
        bail!("不支持的 YClaude Key 文件版本");
    }
    let id = export.key_id.parse::<u64>().ok().filter(|id| *id > 0 && id.to_string() == export.key_id);
    let Some(id) = id else { bail!("导出文件里的 Key 标识无效") };
    if name.is_empty()
        || name.chars().any(char::is_control)
        || !is_valid_api_key(key)
    {
        bail!("导出文件里的分组或 API Key 无效");
    }
    Ok(UpstreamProfile {
        name: name.into(),
        base_url: GATEWAY_URL.into(),
        api_key: key.into(),
        source: SOURCE_WEB.into(),
        source_id: id.to_string(),
        ..UpstreamProfile::default()
    })
}

pub fn is_valid_api_key(key: &str) -> bool {
    let key = key.trim();
    !key.is_empty() && key.bytes().all(|byte| byte.is_ascii_graphic())
}

pub fn is_fixed_gateway(url: &str) -> bool {
    url.trim().trim_end_matches('/') == GATEWAY_URL
}

/// 一组上游。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpstreamProfile {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub small_model: String,
    pub models: Vec<String>,
    pub context_window: Option<u64>,
    /// 模型显示名（上游 `/v1/models` 的 `display_name`）。Magpie 的路由组 id 不可读，全靠它。
    pub model_names: BTreeMap<String, String>,
    /// `manual` / `ccswitch` / `magpie` / `codexpp`。
    pub source: String,
    /// 来源里的标识（cc-switch 的供应商 id 等）；再次导入时据此更新而不是重复添加。
    pub source_id: String,
}

impl UpstreamProfile {
    /// 交给本地兼容服务的上游：默认模型排第一、去重；所有模型共用一个窗口（没声明就不声明）。
    pub fn to_upstream(&self) -> Upstream {
        let model = self.model.trim().to_string();
        let mut models: Vec<String> = Vec::new();
        for candidate in std::iter::once(&self.model).chain(self.models.iter()) {
            let candidate = candidate.trim();
            if !candidate.is_empty() && !models.iter().any(|known| known == candidate) {
                models.push(candidate.to_string());
            }
        }
        let small_model = Some(self.small_model.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| model.clone());
        let window = self.context_window.filter(|window| *window > 0);
        let model_windows = window
            .map(|window| models.iter().map(|id| (id.clone(), window)).collect())
            .unwrap_or_default();
        let model_names = models
            .iter()
            .map(|id| {
                let name = self
                    .model_names
                    .get(id)
                    .map(|name| name.trim())
                    .filter(|name| !name.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| claude_local::friendly_model_name(id.rsplit('/').next().unwrap_or(id)));
                (id.clone(), serde_json::json!({ "name": name, "description": self.name }))
            })
            .collect();
        Upstream {
            root: GATEWAY_URL.into(),
            token: self.api_key.trim().to_string(),
            default_model: model,
            small_model,
            models,
            hidden_models: Vec::new(),
            model_names,
            model_windows,
            default_window: window,
            extra_env: Vec::new(),
        }
    }
}

/// 全部上游与当前选中的那组。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UpstreamBook {
    pub profiles: Vec<UpstreamProfile>,
    pub active_id: Option<String>,
}

impl UpstreamBook {
    pub fn active(&self) -> Option<&UpstreamProfile> {
        let id = self.active_id.as_deref()?;
        self.profiles.iter().find(|profile| profile.id == id)
    }

    pub fn import_web_key(&mut self, content: &str) -> Result<String> {
        let mut profile = parse_web_key(content)?;
        if let Some(existing) = self.profiles.iter_mut().find(|known| {
            known.source == SOURCE_WEB && known.source_id == profile.source_id
        }) {
            existing.name = profile.name;
            existing.api_key = profile.api_key;
            return Ok(existing.id.clone());
        }
        // A previously configured Key can keep its model selection when first imported.
        if let Some(existing) = self.profiles.iter().find(|known| {
            known.source != SOURCE_WEB && known.api_key.trim() == profile.api_key
        }) {
            profile = UpstreamProfile {
                name: profile.name,
                base_url: profile.base_url,
                api_key: profile.api_key,
                source: profile.source,
                source_id: profile.source_id,
                ..existing.clone()
            };
        }
        Ok(self.upsert(profile))
    }

    /// 新增或更新一组：没有 id 的算新增；第一组自动选中。返回它的 id。
    pub fn upsert(&mut self, mut profile: UpstreamProfile) -> String {
        profile.base_url = profile.base_url.trim().trim_end_matches('/').to_string();
        profile.name = profile.name.trim().to_string();
        if profile.name.is_empty() {
            profile.name = host_of(&profile.base_url).unwrap_or_else(|| "未命名".into());
        }
        if profile.source.is_empty() {
            profile.source = SOURCE_MANUAL.into();
        }
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }
        let id = profile.id.clone();
        match self.profiles.iter_mut().find(|known| known.id == id) {
            Some(known) => *known = profile,
            None => self.profiles.push(profile),
        }
        if self.active().is_none() {
            self.active_id = Some(id.clone());
        }
        id
    }

    pub fn remove(&mut self, id: &str) {
        self.profiles.retain(|profile| profile.id != id);
        if self.active().is_none() {
            self.active_id = self.profiles.first().map(|profile| profile.id.clone());
        }
    }
}

fn host_of(url: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .ok()?
        .host_str()
        .map(str::to_string)
}

pub fn groups_path() -> PathBuf {
    crate::host::state_dir().join(GROUPS_FILE)
}

pub fn load_groups() -> Result<UpstreamBook> {
    let path = groups_path();
    load_fixed_groups(&path, &path.with_file_name(BOOK_FILE))
}

fn load_fixed_groups(path: &Path, legacy_path: &Path) -> Result<UpstreamBook> {
    let mut book = match read_book(path)? {
        Some(book) => book,
        None => read_book(legacy_path)?.unwrap_or_default(),
    };
    book.profiles.retain_mut(|profile| {
        if !is_fixed_gateway(&profile.base_url) {
            return false;
        }
        profile.base_url = GATEWAY_URL.into();
        true
    });
    if book.active().is_none() {
        book.active_id = book.profiles.first().map(|profile| profile.id.clone());
    }
    Ok(book)
}

fn read_book(path: &Path) -> Result<Option<UpstreamBook>> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .with_context(|| format!("上游配置文件损坏：{}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error).with_context(|| format!("读取上游配置失败：{}", path.display())),
    }
}

/// 存盘（含 Key，Unix 上权限收紧到仅本人可读写）。
pub fn save_book(path: &Path, book: &UpstreamBook) -> Result<()> {
    claude_local::fsutil::atomic_write(path, &serde_json::to_vec_pretty(book)?)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}


// ── 模型列表 ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamModel {
    pub id: String,
    pub display_name: Option<String>,
    pub context_window: Option<u64>,
}

/// 模型列表的候选地址，按顺序试：
/// 1. Anthropic 风格 `{base}/v1/models`（Magpie / Codex++ 网关都支持）；
/// 2. Base URL 以 `/anthropic` 结尾时（DeepSeek、Kimi 等），去掉这一段再试 OpenAI 风格的
///    `/models`、`/v1/models`——这类地址只把 `/v1/messages` 兼容成 Anthropic 格式，
///    模型列表仍由根地址的 OpenAI 兼容接口提供（DeepSeek 就是 `https://api.deepseek.com/models`）。
///
/// Base URL 带 `/v1` 时直接报错：本地服务发消息是把 `/v1/messages` 直接拼在 Base URL 后面的，
/// 带 `/v1` 的地址对话一定失败；模型列表这边如果迁就它，会把配置错误藏到发消息时才暴露。
fn model_list_urls(base_url: &str) -> Result<Vec<reqwest::Url>> {
    let base = reqwest::Url::parse(base_url.trim())
        .with_context(|| format!("Base URL 不是有效地址：{base_url}"))?;
    let path = base.path().trim_end_matches('/');
    if path.ends_with("/v1") {
        bail!("Base URL 不要带 /v1（{}）：本地服务会直接拼 /v1/messages，请写成根地址", base_url.trim());
    }
    let mut urls = Vec::new();
    let mut push = |path: &str| {
        let mut url = base.clone();
        url.set_path(path);
        if !urls.contains(&url) {
            urls.push(url);
        }
    };
    push(&format!("{path}/v1/models"));
    let lower = path.to_ascii_lowercase();
    if lower.ends_with("/anthropic") {
        let root = &path[..path.len() - "/anthropic".len()];
        push(&format!("{root}/models"));
        push(&format!("{root}/v1/models"));
    }
    Ok(urls)
}

/// 只有接口不存在（404 / 405）才换下一个候选地址。其它状态说明地址是通的，
/// 再试同一主机上的其它路径没有意义，只会把真正的错误拖慢。
fn may_try_next(status: u16) -> bool {
    matches!(status, 404 | 405)
}

/// 先按 Anthropic 格式拉模型列表，接口不存在时再退回 OpenAI 兼容格式（见 [`model_list_urls`]）。
/// 连接失败、超时等传输层错误直接返回：候选地址都在同一主机，换一个也一样连不上。
pub async fn fetch_models(base_url: &str, api_key: &str) -> Result<Vec<UpstreamModel>> {
    let urls = model_list_urls(base_url)?;
    let mut client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(20));
    if matches!(urls.first().and_then(reqwest::Url::host_str), Some("127.0.0.1" | "localhost" | "::1" | "[::1]")) {
        // 本机网关不走系统代理，否则请求会被代理转发出去。
        client = client.no_proxy();
    }
    let client = client.build()?;
    let mut missing = Vec::new();
    for url in urls {
        let response = client
            .get(url.clone())
            .bearer_auth(api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .send()
            .await
            .with_context(|| format!("请求模型列表失败：{url}"))?;
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if may_try_next(status.as_u16()) {
            missing.push(url.to_string());
            continue;
        }
        if !status.is_success() {
            let detail: String = body.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(200).collect();
            bail!("上游返回 {status}：{detail}（{url}）");
        }
        let models = parse_models(&body).with_context(|| format!("{url} 返回的模型列表无法解析"))?;
        if models.is_empty() {
            bail!("{url} 没有返回模型");
        }
        return Ok(models);
    }
    bail!("没有找到模型列表接口（试过 {}）", missing.join("、"))
}

fn parse_models(body: &str) -> Result<Vec<UpstreamModel>> {
    let value: Value = serde_json::from_str(body).context("模型列表不是 JSON")?;
    // Anthropic / Magpie / Codex++ 用 data；个别 OpenAI 兼容网关用 models。
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .and_then(Value::as_array)
        .context("模型列表里没有 data 字段")?;
    let mut seen = BTreeMap::new();
    let mut models = Vec::new();
    for entry in entries {
        let Some(id) = entry.get("id").and_then(Value::as_str).map(str::trim) else {
            continue;
        };
        if id.is_empty() || seen.insert(id.to_string(), ()).is_some() {
            continue;
        }
        models.push(UpstreamModel {
            id: id.to_string(),
            // OpenAI 形状用 name，Anthropic 形状用 display_name。
            display_name: entry
                .get("display_name")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty() && *name != id)
                .map(str::to_string),
            context_window: entry.get("context_window").and_then(Value::as_u64).filter(|v| *v > 0),
        });
    }
    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upsert_assigns_ids_names_and_selects_the_first_profile() {
        let mut book = UpstreamBook::default();
        let id = book.upsert(UpstreamProfile {
            base_url: "https://api.example.com/".into(),
            ..UpstreamProfile::default()
        });
        assert_eq!(book.active_id.as_deref(), Some(id.as_str()));
        let first = book.active().unwrap();
        assert_eq!(first.base_url, "https://api.example.com");
        assert_eq!(first.name, "api.example.com");
        assert_eq!(first.source, SOURCE_MANUAL);
        // 第二组不抢选中；改名按 id 更新。
        let second = book.upsert(UpstreamProfile { name: "B".into(), ..UpstreamProfile::default() });
        assert_eq!(book.active_id.as_deref(), Some(id.as_str()));
        book.upsert(UpstreamProfile { id: second.clone(), name: "B2".into(), ..UpstreamProfile::default() });
        assert_eq!(book.profiles.len(), 2);
        assert_eq!(book.profiles[1].name, "B2");
        // 删掉选中的那组，选中落到剩下的第一组。
        book.remove(&id);
        assert_eq!(book.active_id.as_deref(), Some(second.as_str()));
    }

    #[test]
    fn migration_keeps_only_fixed_gateway_groups_and_preserves_the_legacy_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(GROUPS_FILE);
        let legacy = dir.path().join(BOOK_FILE);
        assert_eq!(load_fixed_groups(&path, &legacy).unwrap(), UpstreamBook::default());
        let mut book = UpstreamBook::default();
        let other = book.upsert(UpstreamProfile { base_url: "https://yueziyue.uk.example.invalid".into(), api_key: "synthetic-foreign".into(), ..UpstreamProfile::default() });
        let allowed = book.upsert(UpstreamProfile { base_url: format!("{GATEWAY_URL}/"), api_key: "synthetic-allowed".into(), ..UpstreamProfile::default() });
        assert_eq!(book.active_id.as_deref(), Some(other.as_str()));
        save_book(&legacy, &book).unwrap();
        let migrated = load_fixed_groups(&path, &legacy).unwrap();
        assert_eq!(migrated.profiles.len(), 1);
        assert_eq!(migrated.active().unwrap().id, allowed);
        assert_eq!(migrated.active().unwrap().to_upstream().root, GATEWAY_URL);
        save_book(&path, &UpstreamBook::default()).unwrap();
        assert_eq!(load_fixed_groups(&path, &legacy).unwrap(), UpstreamBook::default());
        assert_eq!(read_book(&legacy).unwrap(), Some(book));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn web_export_reimports_by_key_id_and_rejects_a_supplied_url() {
        let mut book = UpstreamBook::default();
        let mut export = json!({
            "format": "yclaude-key", "version": 1, "keyId": "42",
            "groupName": "Test Group", "apiKey": "synthetic-old"
        });
        let id = book.import_web_key(&export.to_string()).unwrap();
        book.profiles[0].model = "test-model".into();
        export["apiKey"] = json!("synthetic-rotated");
        assert_eq!(book.import_web_key(&export.to_string()).unwrap(), id);
        assert_eq!(book.profiles.len(), 1);
        assert_eq!(book.active().unwrap().api_key, "synthetic-rotated");
        assert_eq!(book.active().unwrap().model, "test-model");
        export["baseUrl"] = json!("https://example.invalid");
        assert!(book.import_web_key(&export.to_string()).is_err());
        assert_eq!(book.profiles.len(), 1);
    }

    #[test]
    fn model_lists_parse_anthropic_shape_with_optional_windows() {
        let models = parse_models(
            &json!({"data": [
                {"id": "a/claude-opus", "context_window": 1_000_000, "display_name": "Claude Opus · A"},
                {"id": "b/glm-5"},
                {"id": "b/glm-5"},
                {"id": ""}
            ]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            models,
            [
                UpstreamModel { id: "a/claude-opus".into(), display_name: Some("Claude Opus · A".into()), context_window: Some(1_000_000) },
                UpstreamModel { id: "b/glm-5".into(), display_name: None, context_window: None },
            ]
        );
        assert!(parse_models("{}").is_err());
    }

    #[test]
    fn model_lists_parse_openai_shape_from_deepseek() {
        let models = parse_models(
            &json!({"object": "list", "data": [
                {"id": "deepseek-flash", "object": "model", "owned_by": "deepseek", "name": "DeepSeek Flash", "context_window": 128_000},
                {"id": "deepseek-v4-pro", "object": "model", "owned_by": "deepseek"}
            ]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(models[0].display_name.as_deref(), Some("DeepSeek Flash"));
        assert_eq!(models[0].context_window, Some(128_000));
        assert_eq!(models[1].display_name, None);
    }

    #[test]
    fn anthropic_base_falls_back_to_the_root_openai_model_list() {
        let urls = |base: &str| -> Vec<String> { model_list_urls(base).unwrap().iter().map(reqwest::Url::to_string).collect() };
        // DeepSeek：先试 Anthropic 风格的 /v1/models，再试根地址的 OpenAI 风格列表。
        assert_eq!(
            urls("https://api.deepseek.com/anthropic"),
            [
                "https://api.deepseek.com/anthropic/v1/models",
                "https://api.deepseek.com/models",
                "https://api.deepseek.com/v1/models",
            ]
        );
        // 不以 /anthropic 结尾的上游（Magpie、Codex++、普通代理）只试一条。
        assert_eq!(urls("http://127.0.0.1:3425"), ["http://127.0.0.1:3425/v1/models"]);
        assert_eq!(urls("http://127.0.0.1:58001/gw/claude"), ["http://127.0.0.1:58001/gw/claude/v1/models"]);
        // Base URL 带 /v1 时直接报错：这类配置发消息本来就会失败，不能把错误藏起来。
        for base in ["https://api.example.com/v1", "https://api.example.com/v1/"] {
            let error = format!("{:#}", model_list_urls(base).unwrap_err());
            assert!(error.contains("不要带 /v1"), "{error}");
        }
        // 大小写不敏感地识别 /anthropic 后缀，路径本身保留原样；结尾斜杠忽略。
        assert_eq!(&urls("https://api.deepseek.com/Anthropic/")[1..], &urls("https://api.deepseek.com/anthropic")[1..]);
        assert!(model_list_urls("not a url").is_err());
    }

    #[test]
    fn only_missing_endpoints_try_the_next_url() {
        assert!(may_try_next(404));
        assert!(may_try_next(405));
        for status in [200, 401, 403, 500] {
            assert!(!may_try_next(status), "{status}");
        }
    }
}
