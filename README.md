# DSH Codex Mirror

English | [中文](README.zh.md)

Read local Codex sessions live inside DeepSeek Harness, quote them into your DSH work, and hand
progress back to Codex — without copying and pasting, and without modifying anything Codex owns.

## What it does

- **Live, read-only mirror.** Reads `~/.codex/sessions` and `~/.codex/archived_sessions` every
  second, incrementally: only appended bytes are parsed after the first scan.
- **A conversation list that means something.** Codex writes subagent and auto-review traffic into
  the same session tree; those are classified and hidden by default, so the list shows your own
  conversations. A badge marks internal threads when you switch to **全部**.
- **Real user turns, not boilerplate.** `# AGENTS.md instructions`, `<environment_context>`,
  permission blocks, attachment preambles and guardian-review prompts are marked as context and
  collapsed; attachment lists are stripped while the prompt that follows is kept.
- **Quote into DSH.** Right-click a session or message (or use the buttons on hover) to append a
  reference to the current draft, or to create a new independent DSH session that already contains
  it. Nothing is sent for you — you add the task and press send.
- **Progress handoff back to Codex.** **写入 DSH 进展** reads the latest durable user/assistant text
  from the current DSH session, lets you review and edit it, then writes an immutable, hashed
  handoff file plus the exact prompt to paste into the original Codex conversation.
- **Search and navigate.** Search filters the list and highlights matches inside the open
  conversation; `j`/`k` move through sessions, `/` focuses search, `r` refreshes, `q` quotes the
  current session and `Shift+Q` quotes it into a new one.
- **Follows your theme.** The panel reads the DSH theme (light or dark) and re-renders when it
  changes.

## Install

From GitHub:

```sh
dsh plugin --profile <profile> add github:ddyfight/dsh-plugin-codex-mirror
```

From the prebuilt tarball attached to a release:

```sh
dsh plugin --profile <profile> add https://github.com/ddyfight/dsh-plugin-codex-mirror/releases/download/v1.1.2/dsh-plugin-codex-mirror-1.1.2.tgz
```

On DSH Desktop, **Plugins → Add plugin** accepts the same GitHub URL or a local folder.

The package ships no install or build scripts: it is plain ESM plus one prebuilt browser bundle.

## Use

Open **Codex 实时镜像** from the sidebar. The first scan of a large Codex history takes a few
seconds; the panel reports progress and afterwards only reads new bytes.

- Left list: filter **对话 / 全部 / 归档**, search by title, working directory or last message.
- Right pane: the selected conversation with day separators, long messages collapsed, and the
  session's working directory and ID one click away.
- Right-click anywhere in a session or message for the quote menu; hover a message for
  **引用 / 新会话 / 复制**.
- **写入 DSH 进展** prepares the handoff dialog for the selected Codex session.

Handoff files live under `~/.dsh/codex-mirror/handoffs/<codexSessionId>/<dshSessionId>/`
(`latest.md`, `manifest.json`, immutable `history/<sha256>.md`).

## Configuration

The Codex data directory defaults to `~/.codex`. If Codex stores its sessions elsewhere, set it on
the plugin row:

```yaml
- id: codex-mirror
  name: dsh-plugin-codex-mirror
  config:
    root: D:\other\codex-home
```

`~` is expanded. A missing directory is reported as an empty library rather than an error.

## Privacy and limitations

- Read-only: the plugin never writes to `~/.codex`, never touches Codex authentication, SQLite
  databases or windows, and never sends a DSH task for you.
- The HTTP routes accept only loopback requests with a matching Host and Origin, reuse DSH
  authentication, and answer `POST` with a JSON-only body under a size cap.
- Only durable, persisted user and assistant text is mirrored. System prompts, reasoning, tool
  calls, images and transient fragments are excluded by design; the panel never claims a running
  task has finished.
- Codex has no confirmed API to append to a live conversation, so the reverse direction is a
  file-based handoff, not a synthetic Codex message.
- Reading very large histories is bounded by bytes parsed per poll; the first scan is the slowest
  part and the panel shows it.

## Development

```sh
node --test-isolation=none --test store.test.mjs handoff.test.mjs
node verify.mjs && node verify-new-session.mjs && node verify-progress.mjs && node verify-handoff-http.mjs
```

`verify-new-session.mjs` and `verify-progress.mjs` exercise the DSH client bridge with a fake
context; `verify.mjs` covers the HTTP handler, CSP, origin checks and the panel's pure helpers.

## License

MIT
