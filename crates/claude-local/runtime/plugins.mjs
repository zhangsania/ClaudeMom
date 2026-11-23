// 插件：把 Anthropic 公开插件目录里的记录，换成 Claude 账号侧接口要的形状。
//
// 登录官方账号时，插件详情、已装列表、安装包都来自账号下的「插件市场」接口。本地没有账号，
// 这里用公开目录的记录（api.anthropic.com/api/directory/plugins，不用登录）和插件自己的 GitHub 仓库顶上：
// - 详情页先在默认市场里按名字找到 `anthropic-plugin-directory`，再按名字读插件记录；
// - 点「添加」后桌面端从 `plugins/<id>/download` 取一个 zip 解压，Cowork / Code 会话启动时挂进去。

/** 默认市场里的那一项。id 只是原样带进后续请求、和插件记录的 marketplace_id 比对，格式不限。 */
export const DIRECTORY_MARKETPLACE = {
  id: "marketplace_01ClaudeLocalPluginDirectory",
  name: "anthropic-plugin-directory",
  display_name: "Anthropic Plugin Directory",
  source: "directory",
  is_default: true,
  is_visible_for_org: true,
  source_url: null,
  sync_status: "success",
  last_synced_sha: null,
};

/**
 * 目录记录里的源码位置。只认 GitHub 上、带审核过的提交号的仓库：安装包就是那个提交的源码。
 * 连接器之类没有仓库的记录返回 null（装不了）。各段都要拼进下载地址，格式不对的一律不认。
 */
export function pluginRepository(entry) {
  const repository = entry?.source?.type === "directory" ? entry.source.repository : null;
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(repository?.url ?? ""));
  const commit = String(repository?.reviewed_commit ?? "");
  if (!match || !/^[0-9a-f]{40}$/.test(commit)) return null;
  const dir = String(repository.path ?? "").replace(/^\/+|\/+$/g, "");
  if (dir.split("/").some((part) => part === "." || part === "..")) return null;
  return { owner: match[1], repo: match[2], commit, dir, url: `https://github.com/${match[1]}/${match[2]}` };
}

/** 能装的目录记录：有 id、有内部名（详情页地址和桌面端都按它找）、有源码位置。 */
export function installablePlugin(entry) {
  return typeof entry?.id === "string" && typeof entry.manifest_name === "string" && pluginRepository(entry) !== null;
}

/**
 * 目录记录 → 账号侧的插件记录。前端只对少数字段有硬要求（name 等于地址里的名字、marketplace_id 等于市场 id、
 * 有 mcp_servers），其余按它读的字段给。reach 和 hooks 决定安装前弹不弹「会在你的电脑上运行」的确认，按组件如实给。
 */
export function pluginRecord(entry, enabled) {
  const components = (Array.isArray(entry.components) ? entry.components : [])
    .filter((component) => typeof component?.type === "string" && typeof component.name === "string");
  const named = (type) => components.filter((component) => component.type === type);
  const described = ({ name, description }) => ({ name, description: typeof description === "string" ? description : "" });
  const access = new Set(components.map((component) => component.access?.type));
  const local = access.has("runs_on_your_computer");
  const remote = access.has("sends_data_to");
  const repository = pluginRepository(entry);
  return {
    id: entry.id,
    name: entry.manifest_name,
    display_name: typeof entry.name === "string" ? entry.name : entry.manifest_name,
    description: typeof entry.summary === "string" ? entry.summary : "",
    version: typeof entry.release?.version === "string" ? entry.release.version : null,
    marketplace_id: DIRECTORY_MARKETPLACE.id,
    marketplace_name: DIRECTORY_MARKETPLACE.name,
    marketplace_kind: "anthropic_catalog",
    partition_by: "marketplace",
    installation_preference: "available",
    enabled,
    is_shared: false,
    author: { name: typeof entry.publisher?.name === "string" ? entry.publisher.name : repository?.owner ?? "" },
    created_at: typeof entry.added_time === "string" ? entry.added_time : null,
    updated_at: typeof entry.updated_time === "string" ? entry.updated_time : null,
    reach: local && remote ? "remote_privileged" : local ? "privileged" : remote ? "remote" : "contained",
    upstream: repository ? { repo_url: repository.url } : undefined,
    mcp_servers: {},
    skills: named("skill").map((component) => ({ ...described(component), user_invocable: true })),
    commands: named("command").map(described),
    agents: named("agent").map(described),
    hooks: named("hook").map((component) => ({ event: component.name, matchers: [] })),
    components: components.map(({ type, name }) => ({ type, name })),
    content_scan: null,
  };
}

/** 已装插件在组织目录里的记录：公开目录那份，安装状态从「未登录」换成「已启用」。 */
export function installedDirectoryRecord(entry) {
  return {
    ...entry,
    installation: {
      state: "enabled",
      actions: { disable: true, remove: true, save_new_version: false },
      admin_policy: { type: "set", install_mode: "optional" },
    },
  };
}

/** 已装插件在「您的插件」列表（library/mine）里的那一行。 */
export function libraryItem(entry) {
  const record = pluginRecord(entry, true);
  return {
    id: record.id,
    name: record.name,
    display_name: record.display_name,
    description: record.description,
    version: record.version,
    provenance: {
      source: "default",
      author: null,
      marketplace_id: record.marketplace_id,
      marketplace_name: record.marketplace_name,
      marketplace_kind: record.marketplace_kind,
    },
    plugin: { backend_id: record.id, partition_by: record.partition_by },
    skill: null,
    content_scan: null,
    components: record.components,
    viewer: {
      added: true,
      usage: null,
      installed: { enabled: true, installation_preference: null, can_toggle: true, can_remove: true, shared_by_you: false },
    },
  };
}

/**
 * 从 GitHub 的源码 zip 里取出一个子目录，重新打成 zip（条目路径改成相对那个子目录）。
 * 一个仓库放多个插件时，目录记录用 `repository.path` 指到其中一个；整个仓库就是插件的不用走这里。
 * 压缩数据原样搬，不解压；大小和校验和以中央目录为准，写进新的本地文件头。
 */
export function zipSubtree(zip, dir) {
  const END = 0x06054b50, CENTRAL = 0x02014b50, LOCAL = 0x04034b50;
  let end = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === END) { end = at; break; }
  }
  if (end < 0) throw new Error("not a zip archive");
  const count = zip.readUInt16LE(end + 10);
  const prefix = `${dir.replace(/^\/+|\/+$/g, "")}/`;
  const files = [];
  const directory = [];
  let written = 0;
  let at = zip.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== CENTRAL) throw new Error("zip central directory is damaged");
    const flags = zip.readUInt16LE(at + 8);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const next = at + 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    // GitHub 的包最外层是 `<仓库>-<提交号>/`，先去掉它再比子目录。
    const inner = name.slice(name.indexOf("/") + 1);
    if (inner.startsWith(prefix) && inner.length > prefix.length) {
      if (localAt + 30 > zip.length || zip.readUInt32LE(localAt) !== LOCAL) throw new Error("zip entry is damaged");
      const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
      if (dataAt + compressedSize > zip.length) throw new Error("zip entry is damaged");
      const renamed = Buffer.from(inner.slice(prefix.length));
      const local = Buffer.alloc(30);
      local.writeUInt32LE(LOCAL, 0);
      zip.copy(local, 4, at + 6, at + 8);
      local.writeUInt16LE(flags & ~0x08, 6);
      zip.copy(local, 8, at + 10, at + 28);
      local.writeUInt16LE(renamed.length, 26);
      const central = Buffer.from(zip.subarray(at, at + 46));
      central.writeUInt16LE(flags & ~0x08, 8);
      central.writeUInt16LE(renamed.length, 28);
      central.writeUInt16LE(0, 30);
      central.writeUInt16LE(0, 32);
      central.writeUInt32LE(written, 42);
      files.push(local, renamed, zip.subarray(dataAt, dataAt + compressedSize));
      directory.push(central, renamed);
      written += 30 + renamed.length + compressedSize;
    }
    at = next;
  }
  if (!directory.length) throw new Error(`zip has nothing under ${prefix}`);
  const directorySize = directory.reduce((size, part) => size + part.length, 0);
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(END, 0);
  tail.writeUInt16LE(directory.length / 2, 8);
  tail.writeUInt16LE(directory.length / 2, 10);
  tail.writeUInt32LE(directorySize, 12);
  tail.writeUInt32LE(written, 16);
  return Buffer.concat([...files, ...directory, tail]);
}
