# Changelog

All notable changes to Bowcode are listed here. Releases: https://github.com/50xu/bowcode/releases

## 1.39.7
- **Sub-sessions:** a session that another agent launched (`claude -p`, `opencode run`, wrappers under `systemd-run`, …) is nested under its parent in the sidebar, across providers and projects. Open the children from a chevron on the parent row.
- **Release channels:** pick **Stable** or **Beta** in Settings → About. `bowcode update` and `install.sh` take `--channel stable|beta`.
- **File tree:** it loads lazily, so folders with many repos open instantly. Search, @-mentions and the command palette now search files on the server. A single button collapses or expands every folder.
- OpenCode's context meter shows the current context window instead of the summed session total.
- The first click on "+" starts a new session.
- Portal menus stay open while other content scrolls.
- Project, session and subagent rows in the sidebar are indented more evenly.

## 1.39.6
- Ordered lists in chat leave room for two-digit numbers.
- Reloading a page works when Bowcode is installed under a hidden directory.

## 1.39.5
- Sessions stand apart from their project in the sidebar: indented with a guide line, and only the selected one is highlighted. Bulk **Select** moved into the project's "…" menu.
- Scheduled runs have no time limit by default.
- Long transcripts scroll more smoothly, because the chat has a single scroll container.
- The PWA workspace shrinks for the virtual keyboard again.
- The mobile sidebar closes from its hide button.

## 1.39.4
- iOS PWA: fixed the gap at the bottom of the screen and the keyboard offset, both broken by the Tailwind 4 upgrade.

## 1.39.3
- Queued, send-now and scheduled messages stream live into the tab already showing the session, without a reload.

## 1.39.2
- Fixed the release build on npm 11 / Node 26 (install-script approvals now live in `package.json`).

## 1.39.1
- **Automatic session titles:** new sessions get a 3–7 word title from Claude Haiku, written in the language of the first prompt. Your own renames are never overwritten. The session menu has **Generate title**, and Settings → Sessions can turn this off.
- On Node 22, a scheduled run's time limit now fires reliably.

## 1.39.0
- **Schedules:** run a prompt per project on a recurring schedule or once, using presets or a cron expression in your time zone. A preview shows the next runs, and the run history links each run's session.
- **Session cleanup:** Settings → Sessions can archive or delete sessions after N days without activity. It is off by default and never touches busy or queued sessions.
- **OpenCode 2:** only OpenCode 2.x is supported now (1.x is refused). Codex is upgraded to 0.166, with GPT-6.1 Sol as the default model.
- **Breaking:** the Electron desktop app has been removed. Bowcode ships as a web server, a Docker image and `install.sh`.
- Requires **Node.js 22.22+**. Releases are built on Node 26.
- Upgraded to React 19, Tailwind CSS 4, react-router 8 and Express 5.
- The context meter is measured against what the model's context window can hold.

## 1.38.4
- Conversations are grouped into Today, Yesterday, Previous 7 days and Older, with roomier rows.
- Settings → About forces a fresh release check.
- Server-owned Claude CLI processes are recognised on macOS.
- Added `favicon.ico`.

## 1.38.3
- Removed references to the upstream project.

## 1.38.2
- Repository moved to `50xu/bowcode`.

## 1.38.1
- New README and screenshots.
- Long session titles no longer push the session menu off-screen on phones.

## 1.38.0
- First Bowcode release: one-line install for Linux and macOS, background service, `bowcode update` and one-click update from Settings → About.
- One agent per session, live view of terminal sessions, git-backed settings sync, desktop split view, iOS-style PWA and redesigned settings.
