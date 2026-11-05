# Bowcode

Bowcode — a self-hosted web UI to drive Claude Code, Codex and OpenCode remotely, from your phone or any browser.

## Features

- One agent per session, with live TUI sessions.
- Git-backed settings sync.
- Desktop split view and an iOS-friendly PWA.
- File explorer, terminal and project navigation.

Bowcode is self-hosted; vendor, Pro and hosted services are not included.

## Install

Requires Linux or macOS, Node.js 22 or newer, npm, and a configured Claude Code, Codex or OpenCode CLI.

```sh
curl -fsSL https://raw.githubusercontent.com/vantran-se/bowcode/main/install.sh | bash
```

The installer downloads the latest GitHub Release tarball and installs a background service on port 3001. To pin a version or skip the service, download `install.sh` and run `bash install.sh --version v1.38.0 --no-service` (use `--port N` to change the port).

For a manual install:

```sh
npm install -g https://github.com/vantran-se/bowcode/releases/latest/download/bowcode.tgz --allow-scripts=bowcode,bcrypt,better-sqlite3,node-pty
bowcode service install --port 3001
```

Open `http://<hostname>:3001` and create an account. Run `bowcode update` for future releases. Configuration and local data are stored under `~/.bowcode`.

To run from source instead:

```sh
git clone https://github.com/vantran-se/bowcode.git
cd bowcode
npm ci
npm run build
node dist-server/server/modules/cli/cli.js start
```

For development, run `npm run dev` from the repository root.

## Desktop

The optional Electron desktop companion can be launched from a source checkout with `npm run desktop`. Local mode connects to your self-hosted server or starts a bundled server. Desktop release downloads still point to the upstream release source until Bowcode publishes its own runtime bundles.

## Documentation

See [architecture notes](docs/architecture/README.md), [Docker sandbox instructions](docker/README.md), and [contributing](CONTRIBUTING.md).

## Origin & license

Bowcode is a modified fork of CloudCLI UI (https://github.com/siteboon/claudecodeui).

It is not affiliated with or endorsed by Siteboon AI B.V. Licensed under AGPL-3.0-or-later with the additional terms in LICENSE (Section 7).

Major changes in this fork:
- One agent per session and a live view of TUI sessions.
- Git-backed settings sync and desktop split view.
- An iOS-friendly PWA; vendor, Pro, and hosted code removed.

See [NOTICE](NOTICE) for original copyright and licensing information. Claude Code, Codex, and OpenCode are third-party tools.
