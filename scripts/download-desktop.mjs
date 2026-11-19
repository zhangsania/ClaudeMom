import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const origin = "https://downloads.claude.ai";
const releases = JSON.parse(await readFile(new URL("./desktop-releases.json", import.meta.url), "utf8"));

export function desktopRelease(version, platform) {
  if (!Object.hasOwn(releases, version) || !Object.hasOwn(releases[version], platform)) {
    throw new Error(`No pinned Claude Desktop package for ${version} / ${platform}`);
  }
  const pin = releases[version][platform];
  const url = new URL(pin.path, origin);
  if (url.origin !== origin || !url.pathname.startsWith("/releases/") ||
      !/^[a-f0-9]{64}$/.test(pin.sha256) || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0) {
    throw new Error("Invalid Claude Desktop package pin");
  }
  return { ...pin, url, filename: path.posix.basename(url.pathname) };
}

export async function saveDesktopPackage(release, dest, get = fetch) {
  await mkdir(dest, { recursive: true });
  const staging = await mkdtemp(path.join(dest, ".claude-desktop-"));
  const temp = path.join(staging, "download");
  const target = path.join(dest, release.filename);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const response = await get(release.url, { redirect: "error", signal: AbortSignal.timeout(15 * 60_000) });
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Download failed (HTTP ${response.status})`);
    }
    const verify = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > release.bytes) {
          callback(new Error("Claude Desktop package is larger than its pin"));
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(response.body, verify, createWriteStream(temp, { flags: "wx" }));
    if (bytes !== release.bytes || hash.digest("hex") !== release.sha256) {
      throw new Error("Claude Desktop package failed size or SHA-256 verification");
    }
    // Publish the verified file without ever replacing an existing package.
    await link(temp, target);
    return target;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      version: { type: "string" },
      platform: { type: "string" },
      dest: { type: "string", default: "desktop-downloads" },
      list: { type: "boolean" },
    },
  });
  if (values.list) {
    for (const [version, platforms] of Object.entries(releases)) {
      console.log(`${version}  ${Object.keys(platforms).join(" ")}`);
    }
    return;
  }
  if (!values.version) throw new Error("Specify --version, or use --list to see pinned versions");
  const release = desktopRelease(values.version, values.platform ?? `${process.platform}-${process.arch}`);
  const output = await saveDesktopPackage(release, path.resolve(values.dest));
  console.log(`${output}\nSHA-256 ${release.sha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
