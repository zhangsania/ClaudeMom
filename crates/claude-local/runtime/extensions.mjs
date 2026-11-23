// 页面扩展：扩展包是一个文件夹 <id>/manifest.json + 清单里列出的 js / css。
// 启用了哪些写在状态文件里（{"enabled": [...]}，ClaudeMom 改），每次请求现读：开关、改文件都是刷新页面就生效。
// 只提供清单里列出的、启用中的扩展的文件；不跟符号链接，不出扩展自己的文件夹。
// 清单规则与 src/extensions.rs 一致。
import fs from "node:fs";
import path from "node:path";

export const EXTENSION_PREFIX = "/__codex_plus/ext/";
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FILE = /^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*$/;
const MAX_FILES = 32;

const text = (value, max) => typeof value === "string" && value.length <= max;
const files = (value, ext) => value === undefined ? [] :
  Array.isArray(value) && value.length <= MAX_FILES && value.every((file) => text(file, 256) && FILE.test(file) && file.endsWith(ext))
    ? value
    : null;

/** 合法时返回 {id, name, version, scripts, styles}，否则 null。 */
export function parseManifest(raw, id) {
  let manifest;
  try { manifest = JSON.parse(raw); } catch { return null; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  if (manifest.id !== id || !ID.test(id)) return null;
  if (!text(manifest.name, 64) || !manifest.name.trim() || !text(manifest.version, 64) || !VERSION.test(manifest.version)) return null;
  // null 和不写一样（Rust 侧按 Option 读）。
  if (manifest.author != null && !text(manifest.author, 64)) return null;
  if (manifest.description != null && !text(manifest.description, 500)) return null;
  const scripts = files(manifest.scripts, ".js");
  const styles = files(manifest.styles, ".css");
  if (!scripts || !styles || !scripts.length && !styles.length) return null;
  return { id, name: manifest.name, version: manifest.version, scripts, styles };
}

/** dirs：先内置后用户，同 id 以先找到的为准。 */
export function createExtensions({ dirs, stateFile }) {
  const enabledIds = () => {
    try {
      const enabled = JSON.parse(fs.readFileSync(stateFile, "utf8")).enabled;
      return Array.isArray(enabled) ? [...new Set(enabled.filter((id) => typeof id === "string" && ID.test(id)))].sort() : [];
    } catch {
      return [];
    }
  };
  const load = (id) => {
    for (const dir of dirs) {
      const root = path.join(dir, id);
      try {
        if (!fs.lstatSync(root).isDirectory()) continue;
        const manifest = parseManifest(fs.readFileSync(path.join(root, "manifest.json"), "utf8"), id);
        if (manifest) return { ...manifest, root };
      } catch {}
    }
    return null;
  };
  const enabled = () => enabledIds().map(load).filter(Boolean);

  return {
    /** 要插进页面的标签，按扩展 id 排序；每个扩展先样式后脚本，按清单顺序。 */
    assets() {
      return enabled().flatMap(({ id, scripts, styles }) => [
        ...styles.map((file) => ({ type: "style", href: `${EXTENSION_PREFIX}${id}/${file}` })),
        ...scripts.map((file) => ({ type: "script", href: `${EXTENSION_PREFIX}${id}/${file}` })),
      ]);
    },
    /** pathname 去掉前缀后的 `<id>/<file>`；不是启用中扩展清单里的文件就返回 null。 */
    read(rest) {
      const slash = rest.indexOf("/");
      if (slash < 1) return null;
      const id = rest.slice(0, slash);
      const file = rest.slice(slash + 1);
      if (!ID.test(id) || !enabledIds().includes(id)) return null;
      const extension = load(id);
      if (!extension) return null;
      const type = extension.scripts.includes(file) ? "text/javascript; charset=utf-8"
        : extension.styles.includes(file) ? "text/css; charset=utf-8"
        : null;
      if (!type) return null;
      try {
        const full = path.join(extension.root, file);
        if (!fs.lstatSync(full).isFile()) return null;
        const real = fs.realpathSync(full);
        if (!real.startsWith(fs.realpathSync(extension.root) + path.sep)) return null;
        return { body: fs.readFileSync(real), type };
      } catch {
        return null;
      }
    },
  };
}
