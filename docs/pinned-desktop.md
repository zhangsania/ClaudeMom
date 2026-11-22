# Claude Desktop pin and message forwarding

In YClaude, the Windows x64 and Mac Apple Silicon downloads are at the bottom
of Claude Settings. Windows uses a `.nupkg` package; macOS uses a ZIP containing
`Claude.app`. For a download with size and SHA-256 verification, use Node.js 22
or newer from the source checkout:

```text
node scripts/download-desktop.mjs --list
node scripts/download-desktop.mjs --version 5.11492.5 --platform win32-x64 --dest desktop-downloads
node scripts/download-desktop.mjs --version 5.11492.5 --platform darwin-arm64 --dest desktop-downloads
```

The downloader saves the official Windows update package or macOS application
archive. It checks the pinned size and SHA-256, does not fall back to another
version, and does not install or run Claude Desktop. To add another version,
verify its official package URL, size and SHA-256, then add an entry to
`scripts/desktop-releases.json`.

On Windows, YClaude looks first for a standalone copy that matches the pinned
executable and core `resources/app.asar` hashes, then for other standalone
installations. It can still use an existing Store installation if no standalone
copy is found. On macOS it looks for `Claude.app` in `/Applications` and then
`~/Applications`.

When launching an older Windows x64 Desktop, ClaudeMom downloads only the
pinned standalone release, verifies its length and SHA-256, and stages it
in the current user's `Programs\ClaudeMom\Desktop-5.11492.5` directory.
The existing installation remains intact. A matching or newer version
does not trigger an automatic download or downgrade. Failed downloads and
installs stop that launch and leave the existing copy intact.

ClaudeMom keeps incoming `POST /v1/messages` bodies byte for byte by default.
The gateway must accept the model ID supplied by the client. Set
`CLAUDE_LOCAL_PRESERVE_MESSAGE_BODY=0` in ClaudeMom's launch environment to
restore the legacy model mapping and request sanitization. ClaudeMom uses its
existing gateway authentication and transport in either case.
`POST /v1/messages/count_tokens` always forwards its raw body to the configured
gateway. The gateway must support that endpoint; Mom returns its response
without a local estimate, including when the gateway returns an error.

In full desktop mode, ClaudeMom denies third-party HTTPS tunnels and does
not forward unhandled official web/API requests. The local gateway listener
forwards only `POST /v1/messages` and `POST /v1/messages/count_tokens`.
Existing local responses and selected public Claude UI assets and component
downloads remain available. Third-party connectors, previews or other
features may fail where they use the local proxy. This policy does not
restrict programs that connect independently of ClaudeMom.

ClaudeMom sets `DISABLE_AUTOUPDATER=1` in the launch environment for the
embedded Code client. For full desktop mode, its local proxy answers Desktop
update feed requests with no update and blocks Desktop application packages.
Official UI assets and Code, SSH and VM component downloads remain available.
Third-party gateway mode uses Desktop's launch configuration for its own updater.
ClaudeMom does not write system update policies or require administrator access
for these settings. They do not change Microsoft Store updates or ClaudeMom's
own updater.

For the Sub2API create-key dialog, stage the finished ClaudeMom installers at
versioned URLs on the gateway's web origin. For example:

```dotenv
VITE_CLAUDEMOM_WINDOWS_DOWNLOAD=/downloads/claudemom/ClaudeMom_custom_x64-setup.exe
VITE_CLAUDEMOM_MACOS_DOWNLOAD=/downloads/claudemom/ClaudeMom_custom_arm64.dmg
```

Set these values when building the gateway frontend. Serve the exact files
with the gateway's static asset override or from its web proxy, and verify
that each URL returns the installer before promoting the frontend. Leave the
value unset for any platform without a distributable installer; the create-key
dialog will omit that link. These URLs refer to the modified ClaudeMom
installers, not the separately downloaded Claude Desktop packages.

The Apple App Store listing for Claude is not the native Claude Desktop
installer. Apple's last-compatible downloads do not let customers choose an
arbitrary Desktop release. The Microsoft Store listing for Claude
(`9P6K58THS811`) advertises no selectable version in WinGet. Use the pinned
official Desktop packages above rather than either store for an exact client
version.

This fork uses the updater feed at
`https://github.com/zhangsania/ClaudeMom/releases/latest/download/latest.json`
and its own Tauri updater public key. A release must be built and signed with
the matching private key in the publishing repository's Actions secrets. On
macOS it also requires the publisher's Apple signing and notarization
credentials. Upstream releases are not accepted as updates for this fork.
