//! 找到本机安装的原版 Claude Desktop、读它的版本。Codex++ 的汉化副本（补丁 Desktop）也用这里。

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
#[cfg(any(target_os = "windows", test))]
use sha2::{Digest, Sha256};

/// 单次探测（启动 PowerShell / defaults 等）的上限。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(12);

/// 探测输出落在临时文件，避免子进程填满管道后阻塞；超时确实终止并回收子进程。
#[derive(Debug)]
pub struct ProbeOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
}

pub fn probe_output(command: &mut Command, deadline: Instant) -> Result<ProbeOutput> {
    ensure!(Instant::now() < deadline, "Claude 检测超时，请重试");
    let path = std::env::temp_dir().join(format!("codex-plus-claude-probe-{}.tmp", uuid::Uuid::new_v4()));
    struct Capture(PathBuf);
    impl Drop for Capture {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }
    let mut capture = fs::OpenOptions::new().read(true).write(true).create_new(true).open(&path)?;
    // 句柄必须先关闭再移除（Windows 不允许删除仍打开的文件）。
    let cleanup = Capture(path);
    let result = (|| {
        command.stdin(Stdio::null()).stdout(capture.try_clone()?).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(crate::CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().context("无法启动 Claude 检测程序")?;
        let deadline = deadline.min(Instant::now() + PROBE_TIMEOUT);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                result => {
                    let _ = child.kill();
                    let _ = child.wait();
                    if let Err(error) = result { return Err(error.into()); }
                    bail!("Claude 检测超时，检测进程已结束，请重试");
                }
            }
        };
        capture.seek(SeekFrom::Start(0))?;
        let mut stdout = Vec::new();
        capture.by_ref().take(64 * 1024).read_to_end(&mut stdout)?;
        Ok(ProbeOutput { status, stdout })
    })();
    // Command 自身也持有重定向句柄，结束后释放它们才可清理临时文件。
    command.stdout(Stdio::null());
    drop(capture);
    drop(cleanup);
    result
}


#[cfg(target_os = "macos")]
pub fn source_app(_deadline: Instant) -> Result<PathBuf> {
    let system = PathBuf::from("/Applications/Claude.app");
    if system.is_dir() {
        return Ok(system);
    }
    Ok(home_dir().join("Applications/Claude.app"))
}

#[cfg(target_os = "windows")]
pub fn source_app(deadline: Instant) -> Result<PathBuf> {
    source_app_with_pin(deadline, None)
}

#[cfg(any(target_os = "windows", test))]
#[derive(Clone, Copy)]
pub struct WindowsDesktopPin<'a> {
    pub version: &'a str,
    pub exe_sha256: &'a str,
    pub asar_sha256: &'a str,
}

#[cfg(any(target_os = "windows", test))]
impl WindowsDesktopPin<'_> {
    pub fn matches(self, exe: &Path) -> bool {
        let Some(parent) = exe.parent() else { return false };
        file_matches_sha256(&parent.join("resources").join("app.asar"), self.asar_sha256)
            && file_matches_sha256(exe, self.exe_sha256)
    }
}

#[cfg(target_os = "windows")]
pub fn windows_pinned_install_dir(local: &Path, version: &str) -> PathBuf {
    local.join("Programs").join("ClaudeMom").join(format!("Desktop-{version}"))
}

#[cfg(target_os = "windows")]
pub(crate) fn source_app_with_pin(
    deadline: Instant,
    pin: Option<WindowsDesktopPin<'_>>,
) -> Result<PathBuf> {
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(home_dir);
    let program = std::env::var_os("ProgramFiles").map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Program Files"));
    let standalone = [
        local.join(r"Programs\Claude\Claude.exe"),
        local.join(r"Programs\claude-desktop\Claude.exe"),
        local.join(r"Claude\Claude.exe"),
        program.join(r"Claude\Claude.exe"),
    ];
    let mom_install = pin.map(|pin| windows_pinned_install_dir(&local, pin.version).join("Claude.exe"));
    prefer_standalone(mom_install.as_deref(), &standalone, pin, || {
        find_default_windows_desktop(&local, &standalone, deadline)
    })
}

#[cfg(any(target_os = "windows", test))]
fn prefer_standalone(
    managed: Option<&Path>,
    standalone: &[PathBuf],
    pin: Option<WindowsDesktopPin<'_>>,
    fallback: impl FnOnce() -> Result<PathBuf>,
) -> Result<PathBuf> {
    if let Some(pin) = pin {
        if let Some(exe) = managed
            .into_iter()
            .chain(standalone.iter().map(PathBuf::as_path))
            .find(|exe| pin.matches(exe))
        {
            return Ok(exe.to_path_buf());
        }
        if let Some(exe) = standalone.iter().find(|exe| exe.is_file()) {
            return Ok(exe.clone());
        }
    }
    fallback()
}

#[cfg(any(target_os = "windows", test))]
fn file_matches_sha256(path: &Path, expected: &str) -> bool {
    let Ok(mut file) = fs::File::open(path) else { return false };
    if !file.metadata().is_ok_and(|metadata| metadata.is_file()) {
        return false;
    }
    let mut digest = Sha256::new();
    std::io::copy(&mut file, &mut digest).is_ok() && format!("{:x}", digest.finalize()) == expected
}

#[cfg(target_os = "windows")]
fn find_default_windows_desktop(
    local: &Path,
    standalone: &[PathBuf],
    deadline: Instant,
) -> Result<PathBuf> {
    let query = probe_output(Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; @(Get-AppxPackage -Name Claude; Get-AppxPackage -Name AnthropicPBC.Claude) | Select-Object Name,InstallLocation | ConvertTo-Json -Compress"]), deadline);
    if let Ok(output) = &query {
        if output.status.success() {
            for install in claude_package_locations(&output.stdout)? {
                let packaged = PathBuf::from(install).join(r"app\Claude.exe");
                if packaged.is_file() { return Ok(packaged); }
            }
        }
    }
    let aliases = [
        local.join(r"Microsoft\WindowsApps\claude-desktop.exe"),
        local.join(r"Microsoft\WindowsApps\Claude_pzs8sxrjxfjjc\claude-desktop.exe"),
    ];
    if let Some(path) = aliases.iter().chain(standalone).find(|path| path.is_file()) {
        return Ok(path.clone());
    }
    // 查询失败不是「未安装」，明确返回错误，避免把超时误报成未安装。
    let output = query?;
    ensure!(output.status.success(), "无法检测 Claude 安装位置，请检查 Windows 应用包服务后重试");
    Ok(local.join(r"Programs\Claude\Claude.exe"))
}

#[cfg(any(target_os = "windows", test))]
fn claude_package_locations(bytes: &[u8]) -> Result<Vec<String>> {
    // PowerShell 对零、一、多条记录分别输出空白、对象、数组。
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    let value: serde_json::Value =
        serde_json::from_slice(bytes).context("Claude 应用包查询返回了无效 JSON")?;
    let records = match &value {
        serde_json::Value::Array(records) => records.as_slice(),
        serde_json::Value::Null => &[],
        _ => std::slice::from_ref(&value),
    };
    Ok(records
        .iter()
        .filter_map(|record| {
            let name = record.get("Name")?.as_str()?;
            if !["Claude", "AnthropicPBC.Claude"]
                .iter()
                .any(|known| name.eq_ignore_ascii_case(known))
            {
                return None;
            }
            let path = record.get("InstallLocation")?.as_str()?.trim();
            (!path.is_empty()).then(|| path.to_string())
        })
        .collect())
}

/// 是否是 Windows 应用商店（MSIX）版 Claude 的入口；其它平台恒为否（路径里不会有 WindowsApps）。
pub fn is_claude_msix_path(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('/', "\\");
    let parts = text
        .split('\\')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let Some(index) = parts
        .iter()
        .position(|part| part.eq_ignore_ascii_case("WindowsApps"))
    else {
        return false;
    };
    let tail = &parts[index + 1..];
    if tail.len() == 1 && tail[0].eq_ignore_ascii_case("claude-desktop.exe") {
        return true; // 已注册的 App Execution Alias。
    }
    let Some(package) = tail.first() else {
        return false;
    };
    let known = ["Claude_", "AnthropicPBC.Claude_"].iter().any(|prefix| {
        package
            .get(..prefix.len())
            .is_some_and(|value| value.eq_ignore_ascii_case(prefix))
    });
    known
        && ((tail.len() == 3
            && tail[1].eq_ignore_ascii_case("app")
            && tail[2].eq_ignore_ascii_case("Claude.exe"))
            || (tail.len() == 2 && tail[1].eq_ignore_ascii_case("claude-desktop.exe")))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn source_app(_deadline: Instant) -> Result<PathBuf> {
    Ok(PathBuf::from("Claude.exe"))
}

fn home_dir() -> PathBuf {
    directories::BaseDirs::new()
        .map(|dirs| dirs.home_dir().to_path_buf())
        .unwrap_or_default()
}


#[cfg(target_os = "macos")]
pub fn app_version(app: &Path, key: &str, deadline: Instant) -> Result<String> {
    if !app.is_dir() { return Ok(String::new()); }
    let output = probe_output(Command::new("/usr/bin/defaults")
        .args(["read"]).arg(app.join("Contents/Info")).arg(key), deadline)?;
    Ok(if output.status.success() { String::from_utf8_lossy(&output.stdout).trim().to_string() } else { String::new() })
}

#[cfg(target_os = "windows")]
pub fn app_version(app: &Path, _key: &str, deadline: Instant) -> Result<String> {
    if !app.is_file() { return Ok(String::new()); }
    let escaped = app.to_string_lossy().replace('\'', "''");
    let output = probe_output(Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(format!("(Get-Item -LiteralPath '{escaped}').VersionInfo.ProductVersion")), deadline)?;
    Ok(if output.status.success() { String::from_utf8_lossy(&output.stdout).trim().to_string() } else { String::new() })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn app_version(_app: &Path, _key: &str, _deadline: Instant) -> Result<String> { Ok(String::new()) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_desktop_prefers_standalone_and_requires_a_verified_managed_copy() {
        let workspace = tempfile::tempdir().unwrap();
        let standalone = workspace.path().join("Claude").join("Claude.exe");
        let managed = workspace.path().join("Managed").join("Claude.exe");
        let resources = managed.parent().unwrap().join("resources");
        let archive = resources.join("app.asar");
        let store = workspace.path().join("WindowsApps").join("Claude.exe");
        let exe_bytes = b"standalone executable fixture";
        let asar_bytes = b"standalone ASAR fixture";
        let exe_sha256 = format!("{:x}", Sha256::digest(exe_bytes));
        let asar_sha256 = format!("{:x}", Sha256::digest(asar_bytes));
        let select = |pin_enabled: bool| {
            prefer_standalone(
                Some(&managed),
                std::slice::from_ref(&standalone),
                pin_enabled.then_some(WindowsDesktopPin {
                    version: "5.11492.5",
                    exe_sha256: &exe_sha256,
                    asar_sha256: &asar_sha256,
                }),
                || Ok(store.clone()),
            )
            .unwrap()
        };

        assert_eq!(select(true), store);
        fs::create_dir_all(resources).unwrap();
        fs::write(&managed, exe_bytes).unwrap();
        assert_eq!(select(true), store);
        fs::create_dir_all(standalone.parent().unwrap()).unwrap();
        fs::write(&standalone, b"installed standalone executable").unwrap();
        assert_eq!(select(true), standalone);
        fs::write(&archive, asar_bytes).unwrap();
        assert_eq!(select(true), managed);
        assert_eq!(select(false), store);
        fs::write(&archive, b"different ASAR").unwrap();
        assert_eq!(select(true), standalone);
        fs::write(&archive, asar_bytes).unwrap();
        fs::write(&managed, b"different executable").unwrap();
        fs::remove_file(&standalone).unwrap();
        assert_eq!(select(true), store);
    }

    #[test]
    fn claude_msix_namespace_discovery_and_classification_agree() {
        let packages = br#"[{"Name":"AnthropicPBC.Claude","InstallLocation":"C:\\Program Files\\WindowsApps\\AnthropicPBC.Claude_2.42304.0.0_x64__fnn82j28hfe8t"},{"Name":"ClaudeFork","InstallLocation":"C:\\Other"}]"#;
        let locations = claude_package_locations(packages).unwrap();
        assert_eq!(locations.len(), 1);
        assert!(is_claude_msix_path(Path::new(&format!(
            "{}\\app\\Claude.exe",
            locations[0]
        ))));
        assert_eq!(
            claude_package_locations(br#"{"Name":"Claude","InstallLocation":"C:\\legacy"}"#)
                .unwrap(),
            vec![r"C:\legacy"]
        );
        assert!(claude_package_locations(b"").unwrap().is_empty());
        assert!(claude_package_locations(b"not JSON").is_err());
    }
}
