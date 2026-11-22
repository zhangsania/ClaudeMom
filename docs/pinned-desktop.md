# Claude Desktop pin and message forwarding

Use Node.js 22 or newer from the ClaudeMom source checkout.

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

Desktop's own updater can be disabled with its documented `disableAutoUpdates`
policy. On Windows, ClaudeMom sets the current user's
`HKCU\SOFTWARE\Policies\Claude\disableAutoUpdates` value to `REG_DWORD 1`
before launching Desktop. This requires no administrator prompt. Desktop
prefers the machine policy if its key contains any values. ClaudeMom leaves
that key untouched and reports a launch error if it cannot confirm that the
machine policy disables updates. This neither downgrades Desktop nor changes
Microsoft Store updates.

ClaudeMom also sets the equivalent gateway configuration in Desktop's third-party
gateway mode. Administrators can apply the Windows policy directly from
`scripts/desktop-policy` or deliver the equivalent Boolean in the macOS managed
preferences domain `com.anthropic.claudefordesktop`. Merge into existing policy;
do not replace unrelated managed preferences. ClaudeMom continues to use this
fork's updater feed.

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
