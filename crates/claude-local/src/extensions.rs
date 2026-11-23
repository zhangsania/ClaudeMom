//! 页面扩展：注入 Claude 页面的 js / css 包。
//!
//! 扩展包是一个文件夹 `<id>/manifest.json` + 清单里列出的文件。内置的随程序打包，装到
//! `<状态目录>/claude-local/extensions-builtin/`；用户导入的放在 `extensions/`。启用了哪些写在
//! `extensions.json`（`{"enabled": [...]}`），本地服务每次请求现读（见 runtime/extensions.mjs），
//! 开关、改文件都是刷新页面就生效。清单规则两边一致。

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};

pub(crate) const BUILTIN_DIR: &str = "extensions-builtin";
const USER_DIR: &str = "extensions";
const STATE_FILE: &str = "extensions.json";
const MAX_FILES: usize = 32;
const MAX_PACKAGE_FILES: usize = 500;
const MAX_PACKAGE_BYTES: u64 = 20 * 1024 * 1024;

/// 内置扩展（路径相对状态目录，随其它运行时资产一起安装）。
pub(crate) const BUILTIN: &[(&str, &[u8])] = &[
    (
        "extensions-builtin/desk-pet/manifest.json",
        include_bytes!("../assets/extensions/desk-pet/manifest.json"),
    ),
    (
        "extensions-builtin/desk-pet/desk-pet.js",
        include_bytes!("../assets/extensions/desk-pet/desk-pet.js"),
    ),
    (
        "extensions-builtin/wide-chat/manifest.json",
        include_bytes!("../assets/extensions/wide-chat/manifest.json"),
    ),
    (
        "extensions-builtin/wide-chat/wide-chat.js",
        include_bytes!("../assets/extensions/wide-chat/wide-chat.js"),
    ),
];

/// 读-改-写启用状态和用户扩展目录时串行。
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub scripts: Vec<String>,
    pub styles: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    pub builtin: bool,
    pub enabled: bool,
    /// 清单有问题时的原因；这样的扩展不会被注入，也不能启用。
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct RawManifest {
    id: String,
    name: String,
    version: String,
    author: Option<String>,
    description: Option<String>,
    #[serde(default)]
    scripts: Vec<String>,
    #[serde(default)]
    styles: Vec<String>,
}

/// 长度按 UTF-16 计，与页面侧（JS 的 `.length`）一致。
fn within(text: &str, max: usize) -> bool {
    text.encode_utf16().count() <= max
}

pub fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// `主.次.修订`，可带 `-预发布` 或 `+构建` 后缀。
fn valid_version(version: &str) -> bool {
    let (core, suffix) = match version.find(['-', '+']) {
        Some(at) => (&version[..at], Some(&version[at + 1..])),
        None => (version, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3
        && parts.iter().all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        && suffix.is_none_or(|rest| {
            !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
        })
}

/// 相对路径：每段由字母数字、`_`、`-`、`.` 组成，且不以 `.` 开头（所以没有 `..`、隐藏文件）。
fn valid_file(file: &str, ext: &str) -> bool {
    within(file, 256)
        && file.ends_with(ext)
        && file.split('/').all(|segment| {
            segment
                .bytes()
                .next()
                .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                && segment.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
        })
}

/// 解析并校验清单；`expected_id` 给了时 id 必须与之相同（文件夹名）。
pub fn parse_manifest(raw: &[u8], expected_id: Option<&str>) -> Result<Manifest> {
    let raw: RawManifest = serde_json::from_slice(raw).context("manifest.json 不是有效的清单")?;
    ensure!(valid_id(&raw.id), "id「{}」不合法：只能用小写字母、数字和 -，最长 64 个字符", raw.id);
    if let Some(expected) = expected_id {
        ensure!(raw.id == expected, "清单里的 id「{}」和文件夹名「{expected}」不一致", raw.id);
    }
    ensure!(!raw.name.trim().is_empty() && within(&raw.name, 64), "name 不能为空，最长 64 个字符");
    ensure!(within(&raw.version, 64) && valid_version(&raw.version), "version「{}」不合法，应形如 1.0.0", raw.version);
    let author = raw.author.unwrap_or_default();
    ensure!(within(&author, 64), "author 最长 64 个字符");
    let description = raw.description.unwrap_or_default();
    ensure!(within(&description, 500), "description 最长 500 个字符");
    for (files, ext) in [(&raw.scripts, ".js"), (&raw.styles, ".css")] {
        ensure!(files.len() <= MAX_FILES, "scripts / styles 各最多 {MAX_FILES} 个文件");
        if let Some(bad) = files.iter().find(|file| !valid_file(file, ext)) {
            bail!("文件路径「{bad}」不合法：要用相对路径、以 {ext} 结尾，不能有隐藏文件或 ..");
        }
    }
    ensure!(!raw.scripts.is_empty() || !raw.styles.is_empty(), "scripts 和 styles 至少要有一个文件");
    Ok(Manifest {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        author,
        description,
        scripts: raw.scripts,
        styles: raw.styles,
    })
}

fn builtin_manifests() -> Vec<Manifest> {
    BUILTIN
        .iter()
        .filter_map(|(path, contents)| {
            let id = path.strip_prefix("extensions-builtin/")?.strip_suffix("/manifest.json")?;
            parse_manifest(contents, Some(id)).ok()
        })
        .collect()
}

fn read_enabled(root: &Path) -> BTreeSet<String> {
    #[derive(Deserialize)]
    struct State {
        enabled: Vec<serde_json::Value>,
    }
    fs::read(root.join(STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_slice::<State>(&raw).ok())
        .map(|state| {
            state
                .enabled
                .into_iter()
                .filter_map(|value| value.as_str().filter(|id| valid_id(id)).map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn write_enabled(root: &Path, enabled: &BTreeSet<String>) -> Result<()> {
    let body = serde_json::to_vec_pretty(&serde_json::json!({ "enabled": enabled }))?;
    crate::fsutil::atomic_write(&root.join(STATE_FILE), &body)
}

fn info(manifest: Manifest, builtin: bool, enabled: &BTreeSet<String>) -> ExtensionInfo {
    ExtensionInfo {
        enabled: enabled.contains(&manifest.id),
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        builtin,
        error: None,
    }
}

/// 内置在前，再按 id 排序。和内置同名的用户扩展被内置盖住，不列出来（页面侧同样以内置为准）。
fn list_in(root: &Path) -> Vec<ExtensionInfo> {
    let enabled = read_enabled(root);
    let mut builtin: Vec<ExtensionInfo> = builtin_manifests().into_iter().map(|m| info(m, true, &enabled)).collect();
    builtin.sort_by(|a, b| a.id.cmp(&b.id));
    let taken: BTreeSet<String> = builtin.iter().map(|item| item.id.clone()).collect();
    let mut user = Vec::new();
    for entry in fs::read_dir(root.join(USER_DIR)).into_iter().flatten().flatten() {
        let id = entry.file_name().to_string_lossy().into_owned();
        if id.starts_with('.') || taken.contains(&id) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let parsed = fs::read(entry.path().join("manifest.json"))
            .context("缺少 manifest.json")
            .and_then(|raw| parse_manifest(&raw, Some(&id)));
        user.push(match parsed {
            Ok(manifest) => info(manifest, false, &enabled),
            Err(error) => ExtensionInfo {
                enabled: false,
                name: id.clone(),
                id,
                version: String::new(),
                author: String::new(),
                description: String::new(),
                builtin: false,
                error: Some(format!("{error:#}")),
            },
        });
    }
    user.sort_by(|a, b| a.id.cmp(&b.id));
    builtin.into_iter().chain(user).collect()
}

fn set_enabled_in(root: &Path, id: &str, on: bool) -> Result<Vec<ExtensionInfo>> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let extension = list_in(root).into_iter().find(|item| item.id == id).context("找不到这个扩展")?;
    if on {
        if let Some(error) = &extension.error {
            bail!("「{}」的清单有问题，不能启用：{error}", extension.name);
        }
    }
    let mut enabled = read_enabled(root);
    if on {
        enabled.insert(id.to_string());
    } else {
        enabled.remove(id);
    }
    write_enabled(root, &enabled)?;
    Ok(list_in(root))
}

fn remove_in(root: &Path, id: &str) -> Result<String> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let extension = list_in(root).into_iter().find(|item| item.id == id).context("找不到这个扩展")?;
    ensure!(!extension.builtin, "内置扩展不能删除，不用的话关掉即可");
    fs::remove_dir_all(root.join(USER_DIR).join(id)).context("删除扩展文件夹失败")?;
    let mut enabled = read_enabled(root);
    if enabled.remove(id) {
        write_enabled(root, &enabled)?;
    }
    Ok(extension.name)
}

/// 导入结果：清单，以及被覆盖的旧版本（之前没装过为 `None`）。
pub struct Imported {
    pub manifest: Manifest,
    pub replaced: Option<String>,
}

/// `source` 是扩展包的 .zip、扩展文件夹，或文件夹里的 manifest.json。
/// 先解到 `extensions/.import-*`，校验通过再整个换进 `extensions/<id>`；同 id 的直接覆盖。
fn import_in(root: &Path, source: &Path) -> Result<Imported> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let user = root.join(USER_DIR);
    crate::private_dir(&user)?;
    let staging = user.join(format!(".import-{}", uuid::Uuid::new_v4()));
    let result = (|| {
        let is_zip = source.is_file()
            && source.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("zip"));
        if is_zip {
            extract_zip(source, &staging)?;
        } else {
            let dir = if source.is_dir() {
                source
            } else if source.file_name().is_some_and(|name| name == "manifest.json") {
                source.parent().context("找不到扩展文件夹")?
            } else {
                bail!("请选择扩展包的 .zip，或扩展文件夹里的 manifest.json");
            };
            fs::create_dir_all(&staging)?;
            let mut budget = Budget::default();
            copy_tree(dir, &staging, &mut budget)?;
        }
        let package = package_root(&staging)?;
        let manifest = parse_manifest(&fs::read(package.join("manifest.json"))?, None)?;
        ensure!(
            !builtin_manifests().iter().any(|builtin| builtin.id == manifest.id),
            "「{}」和内置扩展同 id，请在 manifest.json 里换一个 id",
            manifest.id
        );
        for file in manifest.scripts.iter().chain(&manifest.styles) {
            ensure!(
                fs::symlink_metadata(package.join(file)).is_ok_and(|meta| meta.is_file()),
                "清单里列的 {file} 不在扩展包里"
            );
        }
        let target = user.join(&manifest.id);
        let replaced = fs::read(target.join("manifest.json"))
            .ok()
            .and_then(|raw| parse_manifest(&raw, Some(&manifest.id)).ok())
            .map(|old| old.version);
        if fs::symlink_metadata(&target).is_ok() {
            fs::remove_dir_all(&target).context("替换旧版本失败")?;
        }
        fs::rename(&package, &target).context("安装扩展失败")?;
        Ok(Imported { manifest, replaced })
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// 扩展包大小上限：文件数和总字节。
#[derive(Default)]
struct Budget {
    files: usize,
    bytes: u64,
}

impl Budget {
    fn take(&mut self, bytes: u64) -> Result<()> {
        self.files += 1;
        self.bytes += bytes;
        ensure!(
            self.files <= MAX_PACKAGE_FILES && self.bytes <= MAX_PACKAGE_BYTES,
            "扩展包太大：最多 {MAX_PACKAGE_FILES} 个文件、{} MB",
            MAX_PACKAGE_BYTES / 1024 / 1024
        );
        Ok(())
    }
}

/// 不复制的条目：隐藏文件（.git、.DS_Store）和 macOS 压缩时附带的 __MACOSX。
fn skipped(name: &str) -> bool {
    name.starts_with('.') || name == "__MACOSX"
}

/// 只复制普通文件和文件夹，符号链接一律跳过。
fn copy_tree(from: &Path, to: &Path, budget: &mut Budget) -> Result<()> {
    for entry in fs::read_dir(from).with_context(|| format!("读不了 {}", from.display()))? {
        let entry = entry?;
        let name = entry.file_name();
        if skipped(&name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type()?;
        let target = to.join(&name);
        if kind.is_dir() {
            fs::create_dir_all(&target)?;
            copy_tree(&entry.path(), &target, budget)?;
        } else if kind.is_file() {
            budget.take(entry.metadata()?.len())?;
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn extract_zip(source: &Path, to: &Path) -> Result<()> {
    let mut archive = zip::ZipArchive::new(File::open(source)?).context("不是有效的 zip 文件")?;
    fs::create_dir_all(to)?;
    let mut budget = Budget::default();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        let relative = entry
            .enclosed_name()
            .with_context(|| format!("扩展包里有不安全的路径：{}", entry.name()))?;
        if relative.components().any(|part| skipped(&part.as_os_str().to_string_lossy())) {
            continue;
        }
        let target = to.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target)?;
            continue;
        }
        // 符号链接（unix 模式 0o120000）跳过。
        if entry.unix_mode().is_some_and(|mode| mode & 0o170000 == 0o120000) {
            continue;
        }
        budget.take(entry.size())?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut contents = Vec::new();
        (&mut entry).take(MAX_PACKAGE_BYTES + 1).read_to_end(&mut contents)?;
        ensure!(contents.len() as u64 <= MAX_PACKAGE_BYTES, "扩展包太大");
        File::create(&target)?.write_all(&contents)?;
    }
    Ok(())
}

/// manifest.json 在解开的根上，或在唯一的一层文件夹里（打包时把文件夹本身也压进去了）。
fn package_root(staging: &Path) -> Result<PathBuf> {
    if staging.join("manifest.json").is_file() {
        return Ok(staging.to_path_buf());
    }
    let entries: Vec<PathBuf> = fs::read_dir(staging)?.flatten().map(|entry| entry.path()).collect();
    match entries.as_slice() {
        [only] if only.is_dir() && only.join("manifest.json").is_file() => Ok(only.clone()),
        _ => bail!("扩展包里没有 manifest.json"),
    }
}

/// 已装的扩展：内置在前。
pub fn list() -> Vec<ExtensionInfo> {
    list_in(&crate::backend::root_dir())
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<Vec<ExtensionInfo>> {
    set_enabled_in(&crate::backend::root_dir(), id, enabled)
}

pub fn import(source: &Path) -> Result<Imported> {
    import_in(&crate::backend::root_dir(), source)
}

/// 删除一个用户扩展，返回它的名称。
pub fn remove(id: &str) -> Result<String> {
    remove_in(&crate::backend::root_dir(), id)
}

/// 在访达 / 资源管理器里打开用户扩展文件夹。
pub fn open_folder() -> Result<()> {
    let dir = crate::backend::root_dir().join(USER_DIR);
    crate::private_dir(&dir)?;
    Command::new(if cfg!(windows) { "explorer" } else { "/usr/bin/open" })
        .arg(&dir)
        .spawn()
        .context("无法打开扩展文件夹")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(id: &str, version: &str) -> String {
        serde_json::json!({ "id": id, "name": "Theme", "version": version, "scripts": ["main.js"], "styles": ["css/a.css"] })
            .to_string()
    }

    fn write_package(dir: &Path, id: &str, version: &str) {
        fs::create_dir_all(dir.join("css")).unwrap();
        fs::write(dir.join("manifest.json"), manifest(id, version)).unwrap();
        fs::write(dir.join("main.js"), "window.main = 1;").unwrap();
        fs::write(dir.join("css/a.css"), "body{}").unwrap();
    }

    #[test]
    fn manifests_follow_the_page_side_rules() {
        let ok = parse_manifest(manifest("theme", "1.2.3-beta.1").as_bytes(), Some("theme")).unwrap();
        assert_eq!((ok.name.as_str(), ok.author.as_str()), ("Theme", ""));
        assert!(parse_manifest(manifest("theme", "1.0.0").as_bytes(), Some("other")).is_err());
        for bad_id in ["Theme", "-x", "a_b", ""] {
            assert!(parse_manifest(manifest(bad_id, "1.0.0").as_bytes(), None).is_err(), "{bad_id}");
        }
        for bad_version in ["1.0", "v1.0.0", "1.0.0-", "1.0.0 beta"] {
            assert!(parse_manifest(manifest("theme", bad_version).as_bytes(), None).is_err(), "{bad_version}");
        }
        for bad_file in ["../x.js", ".hidden.js", "a/../b.js", "/abs.js", "x.css", "a//b.js"] {
            let raw = serde_json::json!({ "id": "x", "name": "X", "version": "1.0.0", "scripts": [bad_file] }).to_string();
            assert!(parse_manifest(raw.as_bytes(), None).is_err(), "{bad_file}");
        }
        let empty = serde_json::json!({ "id": "x", "name": "X", "version": "1.0.0" }).to_string();
        assert!(parse_manifest(empty.as_bytes(), None).is_err());
        let wrong_type = serde_json::json!({ "id": "x", "name": "X", "version": "1.0.0", "scripts": "a.js" }).to_string();
        assert!(parse_manifest(wrong_type.as_bytes(), None).is_err());
    }

    #[test]
    fn builtin_extensions_are_valid_and_complete() {
        let builtin = builtin_manifests();
        assert_eq!(builtin.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["desk-pet", "wide-chat"]);
        for manifest in &builtin {
            for file in manifest.scripts.iter().chain(&manifest.styles) {
                let path = format!("extensions-builtin/{}/{file}", manifest.id);
                assert!(BUILTIN.iter().any(|(name, _)| *name == path), "{path}");
            }
        }
    }

    #[test]
    fn import_from_a_folder_lists_enables_replaces_and_removes() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        write_package(source.path(), "theme", "1.0.0");
        fs::write(source.path().join(".DS_Store"), "x").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("/etc/hosts", source.path().join("link.js")).unwrap();

        let imported = import_in(root.path(), &source.path().join("manifest.json")).unwrap();
        assert_eq!((imported.manifest.id.as_str(), imported.replaced), ("theme", None));
        let installed = root.path().join("extensions/theme");
        assert!(installed.join("css/a.css").is_file());
        assert!(!installed.join(".DS_Store").exists());
        assert!(fs::symlink_metadata(installed.join("link.js")).is_err());

        let list = list_in(root.path());
        assert_eq!(list.iter().map(|item| (item.id.as_str(), item.builtin)).collect::<Vec<_>>(),
            [("desk-pet", true), ("wide-chat", true), ("theme", false)]);
        assert!(list.iter().all(|item| !item.enabled));

        let list = set_enabled_in(root.path(), "theme", true).unwrap();
        assert!(list.iter().find(|item| item.id == "theme").unwrap().enabled);
        let list = set_enabled_in(root.path(), "desk-pet", true).unwrap();
        assert!(list.iter().find(|item| item.id == "desk-pet").unwrap().enabled);
        assert_eq!(read_enabled(root.path()).into_iter().collect::<Vec<_>>(), ["desk-pet", "theme"]);

        write_package(source.path(), "theme", "1.1.0");
        let imported = import_in(root.path(), source.path()).unwrap();
        assert_eq!(imported.replaced.as_deref(), Some("1.0.0"));
        let theme = list_in(root.path()).into_iter().find(|item| item.id == "theme").unwrap();
        assert_eq!((theme.version.as_str(), theme.enabled), ("1.1.0", true));

        assert!(remove_in(root.path(), "desk-pet").is_err());
        assert_eq!(remove_in(root.path(), "theme").unwrap(), "Theme");
        assert!(!installed.exists());
        assert_eq!(read_enabled(root.path()).into_iter().collect::<Vec<_>>(), ["desk-pet"]);
        assert!(set_enabled_in(root.path(), "theme", true).is_err());
    }

    #[test]
    fn import_rejects_bad_packages_and_leaves_nothing_behind() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        write_package(source.path(), "desk-pet", "1.0.0");
        assert!(import_in(root.path(), source.path()).is_err(), "和内置同 id");
        write_package(source.path(), "theme", "1.0.0");
        fs::remove_file(source.path().join("main.js")).unwrap();
        assert!(import_in(root.path(), source.path()).is_err(), "清单里的文件缺了");
        let stray = tempfile::tempdir().unwrap();
        fs::write(stray.path().join("readme.txt"), "x").unwrap();
        assert!(import_in(root.path(), &stray.path().join("readme.txt")).is_err());
        let left: Vec<_> = fs::read_dir(root.path().join("extensions")).unwrap().flatten().collect();
        assert!(left.is_empty(), "{left:?}");
    }

    #[test]
    fn broken_user_extensions_are_listed_with_their_error_and_cannot_be_enabled() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("extensions/broken");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.json"), manifest("other", "1.0.0")).unwrap();
        let broken = list_in(root.path()).into_iter().find(|item| item.id == "broken").unwrap();
        assert!(broken.error.as_deref().unwrap().contains("不一致"));
        assert!(set_enabled_in(root.path(), "broken", true).is_err());
        assert!(set_enabled_in(root.path(), "broken", false).is_ok());
    }

    #[test]
    fn import_from_zip_accepts_a_wrapping_folder_and_refuses_unsafe_paths() {
        use zip::write::SimpleFileOptions;
        let root = tempfile::tempdir().unwrap();
        let work = tempfile::tempdir().unwrap();
        let write_zip = |name: &str, entries: &[(&str, &str)]| {
            let path = work.path().join(name);
            let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
            let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
            for (entry, body) in entries {
                writer.start_file(*entry, options).unwrap();
                writer.write_all(body.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
            path
        };
        let theme = manifest("theme", "2.0.0");
        let good = write_zip("theme.ZIP", &[
            ("theme/manifest.json", &theme),
            ("theme/main.js", "window.main = 1;"),
            ("theme/css/a.css", "body{}"),
            ("__MACOSX/theme/._main.js", "junk"),
        ]);
        let imported = import_in(root.path(), &good).unwrap();
        assert_eq!(imported.manifest.version, "2.0.0");
        assert!(root.path().join("extensions/theme/main.js").is_file());

        let evil = write_zip("evil.zip", &[("manifest.json", &theme), ("../escaped.js", "bad")]);
        assert!(import_in(root.path(), &evil).is_err());
        assert!(!root.path().join("escaped.js").exists());
        let none = write_zip("none.zip", &[("readme.txt", "x")]);
        assert!(import_in(root.path(), &none).is_err());
    }
}
