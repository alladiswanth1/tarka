# Tarka

Self-hosted chat UI for any OpenAI-compatible API. One process, no install step, no bundler.

Run a single model in **Solo**, a team of **2–5 AI experts** in **Debate**, or a **2–4** member team that writes real files in **Project**. Point it at OpenRouter, TokenRouter, Together, Fireworks, DeepSeek, Moonshot, local vLLM/Ollama — or at the Claude Code, Codex, or Grok Build CLI already signed in on this machine.

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/npm_dependencies-0-success)](#development)

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick start](#quick-start)
- [Usage](#usage)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Configuration](#configuration)
- [Security](#security)
- [Development](#development)

## Features

| | |
|---|---|
| **Any OpenAI-compatible host** | Custom base URL and API key per provider profile. Keys stay in the browser. |
| **Local Claude Code / Codex / Grok Build** | Detects a signed-in `claude`, `codex`, or `grok` CLI and uses it as a provider. No extra key. |
| **Solo** | Streaming replies, reasoning effort, context meter, edit/resend, export. |
| **Debate** | 2–5 experts, each on its own model/provider. Blind first round, informed consensus, optional judge. |
| **Project** | 2–4 members build inside one folder: files, shell, task board, decisions. |
| **Zero toolchain** | Native ESM in the browser, CommonJS on the server. `node server.js` is the build. |

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- A browser
- An API key for an OpenAI-compatible provider, **or** `claude` / `codex` / `grok` installed and logged in

## Quick start

```bash
cd tarka
node server.js
```

Open [http://127.0.0.1:3000](http://127.0.0.1:3000). There is nothing to `npm install`.

```bash
npm start          # same as node server.js
PORT=8080 node server.js
```

## Usage

### Add a provider

1. Open **API** in the icon rail.
2. Click **＋** and enter a base URL, API key, and model id.

```
Base URL    https://openrouter.ai/api/v1
            https://api.tokenrouter.com/v1
            http://127.0.0.1:11434/v1
API key     stored only in this browser's localStorage
Model       moonshotai/kimi-k3
```

Settings autosave. **Save Config** flushes immediately and re-reads the model catalog.

If Claude Code, Codex, or Grok Build is already signed in, a chip appears on that same panel. Click it — that profile needs no key.

### Solo

Type in the composer and press Enter. Streaming, reasoning, and usage show in the transcript and the inspector.

- Edit a user message to rewind and resend
- Retry on an error line to repeat the last turn
- Export the chat as plain text, Markdown, or JSON

### Debate

1. Toggle **Debate** next to the composer.
2. Give every expert a model and a provider (up to 5 seats).
3. Send the task.

Round 1 is blind and parallel. Later rounds share a transcript. Opening-round votes do not count as consensus. A seat that fails twice drops out; the others continue. The nominated expert writes the final answer, or a neutral judge if you configured one. If the judge is down, the nominee writes and the credit line names who did.

### Project

1. Toggle **Project**.
2. Create a project: a name and an **absolute** folder path. `/`, `$HOME`, system directories, and Tarka’s own tree are refused.
3. Assign 2–4 members. Roles are optional.
4. Instruct the team.

Members read and write files, run commands, and keep a task board. **Stop** ends the session and kills a running command. A `done` claim is refused if nobody did real work (`list_files` is not enough) or if the verifier did not inspect anything. A member cannot verify its own claim.

Work is confined to the assigned folder (symlink-safe). Commands are not containerized; catastrophic shells are blocked. Project APIs are loopback-only. Removing a project does not delete your files. Tarka state lives in `.tarka/` inside the folder.

### Local Claude Code, Codex, and Grok Build

Tarka does not ship those products. It looks for the binaries and for their auth **files** (`~/.claude.json`, `~/.codex/auth.json`, `~/.grok/auth.json`, and the usual fallbacks). It never reads the secret. A ready CLI is a provider on Solo, Debate, and Project.

Grok Build is used as a language model (`--max-turns 1`, no shell or file writes of its own). Project Mode still owns files and commands.

```bash
claude login          # then reopen Tarka
codex login
grok login
```

| Variable | Purpose |
|---|---|
| `TARKA_AGENT_HOME` | Home directory when Tarka’s `$HOME` is redirected |
| `TARKA_CLAUDE_BIN` / `TARKA_CODEX_BIN` / `TARKA_GROK_BIN` | Absolute path if the CLI is not on `PATH` |
| `TARKA_LOCAL_AGENT_TIMEOUT_MS` | Spawn timeout (default `600000`) |

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| <kbd>Enter</kbd> | Send |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | Newline |
| <kbd>Esc</kbd> | Stop generation |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> | Command palette |
| <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd> | New chat |
| <kbd>↑</kbd> | Recall last user message (empty composer) |

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only on a network you trust |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Idle timeout on the upstream chat socket |
| `TARKA_MODELS_TIMEOUT_MS` | `30000` | Timeout for `/models` |
| `TARKA_SSE_KEEPALIVE_MS` | `15000` | SSE comments while a model is silent |
| `TARKA_ALLOWED_HOSTS` | — | Extra `Host` values behind a reverse proxy (`*.example.com` or `*`) |
| `TARKA_APP_NAME` | `Tarka` | Attribution title sent upstream |
| `TARKA_APP_URL` | `http://tarka.localhost/` | Attribution `Referer` |

```bash
HOST=0.0.0.0 node server.js
TARKA_ALLOWED_HOSTS=tarka.example.com node server.js
```

Reasoning effort (`none` / `low` / `medium` / `high` / `max`) is sent as `reasoning.effort` or `reasoning_effort`. A rejected field is retried once, then dropped. The same ladder applies to `max_tokens` / `max_completion_tokens`, `temperature`, and `stream_options`.

Context window, in order: your manual limit, the provider catalog, a size in the model id, a known-family table, then 128k.

## Security

Tarka is a local forwarding proxy. The browser sends the key and base URL; this process fetches that URL. Project mode can write files and run commands.

- Listens on loopback by default
- Rejects cross-site requests and form-style POST bodies
- Requires a `Host` that names this machine (`localhost`, `*.local`, or an IP) unless `TARKA_ALLOWED_HOSTS` is set
- Blocks non-loopback clients from proxying to private addresses
- Keeps Project and local-agent routes on loopback even when `HOST=0.0.0.0`
- Stores API keys only in `localStorage`

## Development

```
tarka/
├── server.js          Listen and route
├── lib/               Proxy, security, local agents, project fs/exec
├── public/            Native ESM UI (`app.js` is wiring only)
├── test/              `node --test` — no extra runner
├── data/              Created on demand
└── ARCHITECTURE.md    Turn flow and contracts
```

```bash
npm test
```

See [ARCHITECTURE.md](ARCHITECTURE.md) before changing mode contracts.
