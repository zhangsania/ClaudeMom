use std::fs::{self, File, OpenOptions};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use claude_local::desktop::{WindowsDesktopPin, windows_pinned_install_dir};
use reqwest::{Client, StatusCode, Url, redirect::Policy};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::desktop_packages::{self, TARGET_VERSION};
const MAX_UNPACKED_BYTES: u64 = 1024 * 1024 * 1024;

#[derive(Clone, Copy)]
pub(crate) struct Release {
    pub pin: WindowsDesktopPin<'static>,
    bytes: u64,
    sha256: &'static str,
}

pub(crate) fn pinned_release() -> Option<Release> {
    if !cfg!(target_arch = "x86_64") {
        return None;
    }
    let release = desktop_packages::package("win32-x64")?;
    Some(Release {
        pin: WindowsDesktopPin {
            version: TARGET_VERSION,
            exe_sha256: release.get("installedExeSha256")?.as_str()?,
            asar_sha256: release.get("appAsarSha256")?.as_str()?,
        },
        bytes: release.get("bytes")?.as_u64()?,
        sha256: release.get("sha256")?.as_str()?,
    })
}

fn version_parts(version: &str) -> Option<[u32; 4]> {
    let mut components = version.trim().split('.');
    let mut parts = [0; 4];
    for part in &mut parts[..3] {
        *part = components.next()?.parse().ok()?;
    }
    if let Some(revision) = components.next() {
        parts[3] = revision.parse().ok()?;
    }
    components.next().is_none().then_some(parts)
}

fn needs_update(installed: &str, target: &str) -> bool {
    matches!((version_parts(installed), version_parts(target)), (Some(old), Some(new)) if old < new)
}

pub(crate) async fn prepare_launch() -> Result<()> {
    let Some(release) = pinned_release() else { return Ok(()) };
    let Some(installed) = tauri::async_runtime::spawn_blocking(
        claude_local::windows_desktop_version_for_update,
    )
    .await??
    else {
        return Ok(());
    };
    if !needs_update(&installed, release.pin.version) {
        return Ok(());
    }

    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .context("无法定位 Windows 当前用户的安装目录")?;
    install_target(&local, release).await.with_context(|| {
        format!("无法安装固定版 Claude Desktop {}", release.pin.version)
    })
}

async fn install_target(local: &Path, release: Release) -> Result<()> {
    let dest = windows_pinned_install_dir(local, release.pin.version);
    let parent = dest.parent().context("无法定位 YClaude 安装目录")?;
    fs::create_dir_all(parent)?;
    if dest.exists() {
        ensure!(release.pin.matches(&dest.join("Claude.exe")), "目标目录已有文件，但未通过校验");
        return Ok(());
    }

    let staging = tempfile::Builder::new().prefix("desktop-update-").tempdir_in(parent)?;
    let package = staging.path().join("desktop.nupkg");
    let client = Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(20))
        .timeout(Duration::from_secs(900))
        .build()?;
    download_package(
        &client,
        desktop_packages::download_url("win32-x64")?,
        release.bytes,
        release.sha256,
        &package,
    )
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let unpacked = staging.path().join("app");
        fs::create_dir(&unpacked)?;
        extract_installation(File::open(package)?, &unpacked)?;
        publish_installation(&unpacked, &dest, release.pin)
    })
    .await??;
    Ok(())
}

async fn download_package(
    client: &Client,
    url: Url,
    expected_bytes: u64,
    sha256: &str,
    path: &Path,
) -> Result<()> {
    let mut response = client.get(url).send().await.context("下载官方安装包失败")?;
    ensure!(response.status() == StatusCode::OK, "下载官方安装包返回 HTTP {}", response.status());
    ensure!(
        response.content_length().is_none_or(|length| length == expected_bytes),
        "官方安装包长度与版本清单不符"
    );
    let mut file = tokio::fs::OpenOptions::new().write(true).create_new(true).open(path).await?;
    let mut bytes = 0_u64;
    let mut digest = Sha256::new();
    while let Some(chunk) = response.chunk().await? {
        bytes += chunk.len() as u64;
        ensure!(bytes <= expected_bytes, "官方安装包超过固定大小");
        digest.update(&chunk);
        file.write_all(&chunk).await?;
    }
    ensure!(
        bytes == expected_bytes && format!("{:x}", digest.finalize()) == sha256,
        "官方安装包大小或 SHA-256 校验失败"
    );
    file.flush().await?;
    Ok(())
}

fn extract_installation(reader: impl io::Read + io::Seek, destination: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(reader)?;
    let mut total = 0_u64;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index)?;
        if !entry.name()?.starts_with("lib/net45/") || entry.is_dir() {
            continue;
        }
        ensure!(!entry.is_symlink(), "官方安装包包含不支持的链接");
        let enclosed = entry.enclosed_name().context("官方安装包含有无效路径")?;
        let relative = enclosed.strip_prefix("lib/net45")?;
        ensure!(
            !relative.as_os_str().is_empty()
                && relative.components().all(|part| matches!(part, Component::Normal(_))),
            "官方安装包含有无效路径"
        );
        let size = entry.size();
        ensure!(size <= MAX_UNPACKED_BYTES - total, "官方安装包解压后超过大小限制");
        total += size;
        let target = destination.join(relative);
        fs::create_dir_all(target.parent().context("官方安装包含有无效路径")?)?;
        let mut output = OpenOptions::new().write(true).create_new(true).open(target)?;
        let copied = io::copy(&mut (&mut entry).take(size + 1), &mut output)?;
        ensure!(copied == size, "官方安装包文件的解压大小不符");
    }
    Ok(())
}

fn publish_installation(unpacked: &Path, dest: &Path, pin: WindowsDesktopPin<'_>) -> Result<()> {
    ensure!(pin.matches(&unpacked.join("Claude.exe")), "解压后的 Desktop 文件未通过校验");
    match fs::rename(unpacked, dest) {
        Ok(()) => Ok(()),
        Err(_) if pin.matches(&dest.join("Claude.exe")) => Ok(()),
        Err(error) => Err(error).context("无法安装 Desktop 到固定版本目录"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Write};
    use std::net::TcpListener;

    const EXE: &[u8] = b"fixture exe";
    const ASAR: &[u8] = b"fixture asar";

    fn sha256(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }

    fn fixture_package() -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (path, bytes) in [
            ("lib/net45/Claude.exe", EXE),
            ("lib/net45/resources/app.asar", ASAR),
            ("README.txt", b"not installed".as_slice()),
        ] {
            writer.start_file(path, zip::write::SimpleFileOptions::default()).unwrap();
            writer.write_all(bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn only_versions_below_the_target_are_eligible() {
        assert!(needs_update("5.999.99", TARGET_VERSION));
        assert!(needs_update("5.11492.4.31", TARGET_VERSION));
        assert!(!needs_update(TARGET_VERSION, TARGET_VERSION));
        assert!(!needs_update("5.11492.5.0", TARGET_VERSION));
        assert!(!needs_update("6.28899.6", TARGET_VERSION));
        assert!(!needs_update("5.11492.5.1", TARGET_VERSION));
        assert!(!needs_update("5.11492", TARGET_VERSION));
        assert!(!needs_update("", TARGET_VERSION));
    }

    #[test]
    fn publishes_only_verified_install_files_and_leaves_existing_copy_intact() {
        let temp = tempfile::tempdir().unwrap();
        let stage = temp.path().join("staging");
        let target = temp.path().join("target");
        fs::create_dir(&stage).unwrap();
        extract_installation(Cursor::new(fixture_package()), &stage).unwrap();
        assert!(!stage.join("README.txt").exists());
        let exe_hash = sha256(EXE);
        let asar_hash = sha256(ASAR);
        let pin = WindowsDesktopPin {
            version: TARGET_VERSION,
            exe_sha256: &exe_hash,
            asar_sha256: &asar_hash,
        };
        assert!(publish_installation(&stage, &target, WindowsDesktopPin {
            asar_sha256: "mismatch",
            ..pin
        }).is_err());
        assert!(!target.exists());
        publish_installation(&stage, &target, pin).unwrap();
        assert!(pin.matches(&target.join("Claude.exe")));
        assert!(!stage.exists());
    }

    #[tokio::test]
    async fn package_download_rejects_altered_bytes_and_redirects() {
        let url = desktop_packages::download_url("win32-x64").unwrap();
        assert_eq!(url.host_str(), Some("downloads.claude.ai"));
        assert!(url.path().ends_with("/AnthropicClaude-5.11492.5-full.nupkg"));

        let temp = tempfile::tempdir().unwrap();
        let package = fixture_package();
        let checksum = sha256(&package);
        let client = Client::builder().no_proxy().redirect(Policy::none())
            .timeout(Duration::from_secs(5)).build().unwrap();
        for case in ["matching", "changed", "redirect"] {
            let mut body = package.clone();
            if case == "changed" {
                body[0] ^= 1;
            }
            let response = if case == "redirect" {
                b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/other-version\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
            } else {
                let mut headers = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()
                ).into_bytes();
                headers.extend(body);
                headers
            };
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = Url::parse(&format!("http://{}/fixture", server.local_addr().unwrap())).unwrap();
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = server.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                assert!((&mut stream).read(&mut request).unwrap() > 0);
                stream.write_all(&response).unwrap();
            });
            let result = download_package(
                &client, url, package.len() as u64, &checksum,
                &temp.path().join(case),
            ).await;
            worker.join().unwrap();
            assert_eq!(result.is_ok(), case == "matching", "{case}: {result:?}");
            if case == "matching" {
                assert_eq!(fs::read(temp.path().join(case)).unwrap(), package);
            }
        }
    }

    #[test]
    #[ignore = "requires an existing offline copy of the official pinned package"]
    fn stages_the_actual_official_package() {
        let release = pinned_release().unwrap();
        let mut archive = File::open(std::env::var_os("CLAUDEMOM_OFFLINE_PACKAGE").unwrap()).unwrap();
        assert_eq!(archive.metadata().unwrap().len(), release.bytes);
        let mut hash = Sha256::new();
        io::copy(&mut archive, &mut hash).unwrap();
        assert_eq!(format!("{:x}", hash.finalize()), release.sha256);
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("staging");
        fs::create_dir(&root).unwrap();
        let archive = File::open(std::env::var_os("CLAUDEMOM_OFFLINE_PACKAGE").unwrap()).unwrap();
        extract_installation(archive, &root).unwrap();
        let destination = temp.path().join("pinned");
        publish_installation(&root, &destination, release.pin).unwrap();
        assert!(release.pin.matches(&destination.join("Claude.exe")));
    }
}
