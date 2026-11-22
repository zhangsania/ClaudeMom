import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const { RELEASE_TAG: tag, REPO: repo, REQUIRE_MACOS: requireMacOS } = process.env;
const release = JSON.parse(readFileSync("release.json", "utf8"));
if (!/^v\d+\.\d+\.\d+$/.test(tag) || tag !== release.tagName) {
  throw new Error("Release tag does not match the requested version");
}
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Missing release repository");

const version = tag.slice(1);
const windows = `YClaude_${version}_x64-setup.exe`;
const macInstaller = `YClaude_${version}_universal.dmg`;
const macUpdate = "YClaude_universal.app.tar.gz";
const macFiles = [macInstaller, macUpdate, `${macUpdate}.sig`];
const asset = (name) => path.join("assets", name);

function requireFile(name) {
  const file = asset(name);
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0) {
    throw new Error(`Missing or empty release asset: ${name}`);
  }
}

function updaterEntry(name) {
  requireFile(name);
  requireFile(`${name}.sig`);
  const signature = readFileSync(asset(`${name}.sig`), "utf8").trim();
  if (!signature) throw new Error(`Empty release signature: ${name}`);
  return {
    signature,
    url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
  };
}

const win = updaterEntry(windows);
const platforms = { "windows-x86_64": win, "windows-x86_64-nsis": win };
if (requireMacOS === "true" || macFiles.some((name) => existsSync(asset(name)))) {
  requireFile(macInstaller);
  const mac = updaterEntry(macUpdate);
  for (const platform of ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"]) {
    platforms[platform] = mac;
  }
}

const payload = { version, notes: release.body ?? "", pub_date: new Date().toISOString(), platforms };
writeFileSync("latest.json", `${JSON.stringify(payload, null, 2)}\n`);
