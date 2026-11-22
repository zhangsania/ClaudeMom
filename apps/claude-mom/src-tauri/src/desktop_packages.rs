use std::sync::OnceLock;

use anyhow::{Context, Result, ensure};
use reqwest::Url;
use serde_json::Value;

pub(crate) const TARGET_VERSION: &str = "5.11492.5";
const DOWNLOAD_ORIGIN: &str = "https://downloads.claude.ai";

pub(crate) fn package(platform: &str) -> Option<&'static Value> {
    if !matches!(platform, "win32-x64" | "darwin-arm64") {
        return None;
    }
    static RELEASES: OnceLock<Option<Value>> = OnceLock::new();
    RELEASES
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../../../scripts/desktop-releases.json")).ok()
        })
        .as_ref()?
        .get(TARGET_VERSION)?
        .get(platform)
}

pub(crate) fn download_url(platform: &str) -> Result<Url> {
    let path = package(platform)
        .and_then(|entry| entry.get("path")?.as_str())
        .context("没有找到对应的官方独立安装包")?;
    let expected = match platform {
        "win32-x64" => {
            path == format!("/releases/win32/x64/AnthropicClaude-{TARGET_VERSION}-full.nupkg")
        }
        "darwin-arm64" => {
            path.starts_with(&format!("/releases/darwin/arm64/{TARGET_VERSION}/Claude-"))
                && path.ends_with(".zip")
        }
        _ => false,
    };
    let url = Url::parse(&format!("{DOWNLOAD_ORIGIN}{path}"))?;
    ensure!(
        expected && url.origin().ascii_serialization() == DOWNLOAD_ORIGIN && url.path() == path,
        "官方独立安装包地址校验失败"
    );
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_links_are_fixed_to_the_supported_official_packages() {
        assert_eq!(
            download_url("win32-x64").unwrap().as_str(),
            "https://downloads.claude.ai/releases/win32/x64/AnthropicClaude-5.11492.5-full.nupkg"
        );
        assert_eq!(
            download_url("darwin-arm64").unwrap().as_str(),
            "https://downloads.claude.ai/releases/darwin/arm64/5.11492.5/Claude-1403e2cf44abfb23809c8ae11238d5e9704a41c2.zip"
        );
        for platform in ["", "darwin-x64", "win32-arm64", "https://fixture.invalid/"] {
            assert!(download_url(platform).is_err());
        }
    }
}
