import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { desktopRelease, saveDesktopPackage } from "./download-desktop.mjs";

test("pins the requested Desktop version and platform without falling back", () => {
  assert.match(desktopRelease("5.11492.5", "win32-x64").filename, /-5\.11492\.5-full\.nupkg$/);
  assert.match(desktopRelease("5.11492.5", "darwin-arm64").url.pathname, /\/arm64\/5\.11492\.5\//);
  assert.throws(() => desktopRelease("0.0.0", "win32-x64"), /No pinned/);
  assert.throws(() => desktopRelease("5.11492.5", "darwin-x64"), /No pinned/);
});

test("only publishes verified bytes and never overwrites an existing file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "desktop-download-test-"));
  const bytes = Buffer.from("synthetic package");
  const release = {
    url: new URL("https://fixture.invalid/package.zip"),
    filename: "package.zip",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const fixture = (body, status = 200) => async (url, options) => {
    assert.equal(url.href, release.url.href);
    assert.equal(options.redirect, "error");
    return new Response(body, { status });
  };
  try {
    await assert.rejects(saveDesktopPackage(release, dir, fixture(null, 404)), /HTTP 404/);
    await assert.rejects(saveDesktopPackage(release, dir, fixture(Buffer.alloc(bytes.length))), /SHA-256/);
    await assert.rejects(saveDesktopPackage(release, dir, fixture(Buffer.alloc(bytes.length + 1))), /larger/);
    assert.deepEqual(await readdir(dir), []);
    const file = await saveDesktopPackage(release, dir, fixture(bytes));
    assert.deepEqual(await readFile(file), bytes);
    await assert.rejects(saveDesktopPackage(release, dir, fixture(bytes)), { code: "EEXIST" });
    assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readdir(dir), [release.filename]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
