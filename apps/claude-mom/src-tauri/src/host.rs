//! ClaudeMom 给 claude-local 的宿主实现：状态目录、设置文件、上游（选中的那组 Base URL + Key）、听写服务。

use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

use anyhow::{Context, Result, bail};
use claude_local::dictation::EngineError;
use claude_local::{ClaudeLocalSettings, Host, Upstream};
use serde_json::Value;

/// 状态目录：`CLAUDE_MOM_STATE_DIR` 覆盖，否则 `~/.claude-mom`。
pub fn state_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("CLAUDE_MOM_STATE_DIR")
        .map(PathBuf::from)
        .filter(|dir| dir.is_absolute())
    {
        return dir;
    }
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().join(".claude-mom"))
        .unwrap_or_else(|| PathBuf::from(".claude-mom"))
}

fn fixed_config() -> ClaudeLocalSettings {
    ClaudeLocalSettings {
        enabled: true,
        localization: true,
        voice_input: false,
        computer_use: true,
        background_mode: true,
        force_background_mode: true,
        cowork: false,
        hub_home: false,
        template: String::new(),
        three_p_mode: false,
        display_name: "Local User".into(),
        email: "local@claude.local".into(),
        plan: "ultra".into(),
        session_sync: true,
        hide_unrouted_models: true,
        code_share_home: Some(true),
        import_cli_sessions: true,
        ..ClaudeLocalSettings::default()
    }
}

pub struct ClaudeMomHost;

impl ClaudeMomHost {
    pub fn install() {
        claude_local::install_host(Arc::new(ClaudeMomHost));
    }

    fn active_upstream(&self) -> Result<Upstream> {
        let book = crate::upstreams::load_groups()?;
        let profile = book
            .active()
            .context("还没有分组：先添加 API Key，或导入网页导出的分组")?;
        let upstream = profile.to_upstream();
        if !crate::upstreams::is_valid_api_key(&upstream.token) {
            bail!("当前分组「{}」的 API Key 无效", profile.name);
        }
        if upstream.default_model.is_empty() {
            bail!("当前分组「{}」还没选默认模型", profile.name);
        }
        Ok(upstream)
    }
}

impl Host for ClaudeMomHost {
    fn state_dir(&self) -> PathBuf {
        state_dir()
    }

    fn ca_name(&self) -> &str {
        "ClaudeMom Local CA"
    }

    fn load_config(&self) -> Result<ClaudeLocalSettings> {
        Ok(fixed_config())
    }

    fn save_config(&self, config: &ClaudeLocalSettings) -> Result<()> {
        if *config != fixed_config() {
            bail!("此版本的 Claude 设置已固定");
        }
        Ok(())
    }

    fn preview_upstream(&self, _config: &ClaudeLocalSettings) -> Result<Upstream> {
        self.active_upstream()
    }

    fn prepare_upstream(&self, _config: &ClaudeLocalSettings) -> Result<Upstream> {
        self.active_upstream()
    }

    fn configure_desktop_launch(&self, command: &mut Command) {
        command.env("DISABLE_AUTOUPDATER", "1");
    }

    #[cfg(target_os = "windows")]
    fn windows_desktop_pin(&self) -> Option<claude_local::desktop::WindowsDesktopPin<'static>> {
        crate::desktop_update::pinned_release().map(|release| release.pin)
    }

    fn restrict_desktop_egress(&self) -> bool {
        true
    }

    fn default_code_share_home(&self) -> bool {
        true
    }

    fn dictation_ready(&self, config: &ClaudeLocalSettings) -> bool {
        config.voice_input && claude_local::dictation::model_ready()
    }

    fn prepare_dictation_service(&self) -> Result<()> {
        let availability: claude_local::dictation::server::Availability = Arc::new(|| {
            let config = ClaudeMomHost.load_config().map_err(|error| EngineError::new(500, format!("{error:#}")))?;
            if !config.voice_input {
                return Err(EngineError::new(403, "原生听写未开启"));
            }
            if !claude_local::dictation::model_ready() {
                return Err(EngineError::new(503, "本地 SenseVoice 模型未就绪"));
            }
            Ok(())
        });
        claude_local::dictation::server::ensure_running(&state_dir(), availability).map(|_| ())
    }

    fn diagnostic(&self, event: &str, detail: Value) {
        crate::log::append(event, detail);
    }
}
