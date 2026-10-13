# Aldine Agent Fork — Progress Log

Running dev log for the MVP in `ALDINE_AGENT_FORK_SPEC.md` (task brief:
`AGENT_TASK_PROMPT.md`). Updated at the end of every work session.

- **Repo:** [github.com/alejp1998/Aladine](https://github.com/alejp1998/Aladine) — work lands on `main`, pushed as we go
  (`upstream` = `trahloff/Aldine`, forked @ `a64536f`, Aldine 0.11.0)
- **Live review URL (ZeroTier):** **`http://10.211.108.8:8095`**, served by the containerised dev stack `deploy/dev-review/docker-compose.yml` (`docker compose -f deploy/dev-review/docker-compose.yml up -d`; machine settings in the git-ignored `deploy/dev-review/.env`).
  - The host firewall (ufw, no sudo) blocks plain host processes from ZeroTier. Only Docker-published ports get through, so only the `web` container is published, on the ZeroTier IP. Aldine, the gateway and the compiler run on a private Docker network.
  - Dev login and the test-project link are in `~/dev/aladine-devdata/README.local.md` on the host. They are kept out of git.
- **Deployment instructions:** `agent-gateway/README.md` (not written yet)

## Status

### Done
- 2026-10-13 — Read spec + task prompt; created branch `agent-fork/mvp`; initialized this log.
- 2026-10-13 — Host check: ZeroTier iface `ztfl6btxm4` = `10.211.108.8/24`; Node 26.7, npm 11.19,
  Docker 29.8 / Compose 5.6. No sudo → no firewall changes; bind services to `10.211.108.8` instead of `0.0.0.0`.
- 2026-10-13 — Local OpenAI-compatible endpoint available for dev: `http://10.211.108.8:11439/v1`
  (`gpt-oss-20b`, `qwen3.8-27b`, `gemma-4-*`, …). No Anthropic key in env yet.

- 2026-10-13 — **Phase 1 reconnaissance complete.** Findings + proposed design in
  [`agent-gateway/DESIGN.md`](agent-gateway/DESIGN.md). Key facts:
  - MCP `edit_file`/`batch_write` with `base_version` already give live-Yjs-merged, all-or-nothing,
    conflict-checked writes → `apply_approved_patch` maps onto them; `propose_patch` can live in the gateway.
  - Agent commits/presence are hard-coded as `Claude` (`gitops.ts:476`, `collab.ts:553`, History/Editor
    string checks) → "User (via Agent)" needs one small, isolated core change.
  - Gateway can authenticate users by forwarding the same-origin session cookie to `/api/auth/me` and mint
    short-lived project-scoped PATs via `POST /api/tokens` (no CSRF/Origin check; verified).
  - OAuth Connect is unusable over plain-http ZeroTier (redirects must be https/loopback).
  - Plugin slot is a 230px left-sidebar tab without selection access → assistant panel needs a small
    `Editor.tsx`/`CodePane.tsx` hook-in behind `aldine.experimental.assistant`.
  - `contentVersion` counters are in-memory → proposals go stale on Aldine restart (must regenerate).

- 2026-10-13 — **Decisions confirmed by user:** (1) attribution via small core change — optional
  `X-Aldine-Agent-Label` header on `/mcp` → commits/presence as `User (via Paper Assistant)`, upstream
  behaviour unchanged without it; (2) credentials via auto-minted 1h project-scoped PATs from the forwarded
  session cookie (reuse until expiry, then revoke). Remaining §2 items proceed as proposed.

- 2026-10-13 — Anthropic key added to `agent-gateway/.env` (git-ignored, mode 600). Default model
  **`claude-haiku-5-5`**; verified streaming + native tool use (`stop_reason: tool_use`).

- 2026-10-13 — Fork published as **Aladine** (`origin` = `alejp1998/Aladine`, `upstream` = `trahloff/Aldine`).
  New README (Lyrebird-style header), pixel-art genie icon + wordmark in `docs/images/`,
  generator `scripts/branding/make_logo.py`.

- 2026-10-13 — **Plan revised (v2)** after a critical review, in `agent-gateway/DESIGN.md` §2. The main changes:
  - runs are jobs, streamed over SSE that can resume after a reconnect;
  - the model gets no write tools;
  - an accepted patch is rebased by its anchors;
  - a deterministic mock provider runs the tests;
  - the work is ordered as vertical slices.
- 2026-10-13 — **Phase 2, gateway core, done** (`agent-gateway/`, Node 24 TypeScript with no build step, its own lockfile):
  - **Aldine client.** Identity comes from the forwarded `aldine_session` cookie, and project access from Aldine's own check. A broker mints 1 h project-scoped tokens, reuses them, and revokes them when replaced. Tool calls go over MCP (stateless HTTP, clients cached per token).
  - **Providers.** Anthropic: adaptive thinking, `effort`, automatic prompt caching, eager tool-input streaming, typed errors. OpenAI-compatible: OpenAI, OpenRouter, vLLM, llama.cpp. A scripted mock.
  - **Loop.** Read-only tools: `list_files`, `read_file`, `search_project`, `get_compile_status`, `compile`, `list_citations`, `list_labels`.
    - Every tool input is checked with zod.
    - Hard caps on steps (12), compiles per run (3), tool time, run time and result size.
    - Cancelling keeps the stored history valid.
  - **API.** Sessions, messages, runs, events, cancel and audit. Runs persist their events, and SSE resumes from `Last-Event-ID`. Sessions are private by default; sharing with the project makes them read-only for others. Mutations need `X-Aladine-Request` and a same-origin `Sec-Fetch-Site`.
  - **Storage.** SQLite through `node:sqlite`, with audit records in a separate `audit.db`.
  - **Tests.** `npm test` passes **29/29** against a fake Aldine. `npm run test:it` passes **4/4** against a real Aldine dev server with real compiles.
  - **Live smoke runs** (`npm run smoke`):
    - **Claude Haiku 5.5:** about 9 s and a correct diagnosis. Prompt caching hit: 8.9 k cached input tokens.
    - **Local `gpt-oss-20b`** through the OpenAI-compatible path: about 67 s and a correct answer.
- 2026-10-13 — Core change: optional `HOST` for Aldine's listen address (default unchanged), in the CHANGELOG. Before it, the dev server was reachable on the campus LAN.

- 2026-10-13 — **Test fixture:** the user's Overleaf export (an 8-page IEEE conference paper, 26 files, 18 MB) was imported into the dev Aldine through the normal ZIP import. It compiles in 2.2 s: 8 pages, 0 errors, 1 warning. **It is not committed** (unpublished paper); it lives only in the dev data directory.
- 2026-10-13 — **Phase 3, assistant panel, done** (`apps/web/src/assistant/`):
  - **Panel.** Right-hand pane after the preview, with Aldine's pointer and keyboard resizer. Width is remembered per browser, and open/closed per user and project. On phones it becomes a drawer. A toolbar toggle opens it.
    - It only appears when `/agent-gateway/config` answers, so a plain Aldine deployment is unchanged.
  - **Chat.** Streaming over EventSource, which resumes with `Last-Event-ID`.
    - Tool activity is shown as one line per call (*Reading main.tex… → Read main.tex (lines 1–120 of 436)*), with the exact input and result in an expandable Details.
    - A context chip shows what will be sent (*main.tex · line 42* / *Selection · 5 lines in intro.tex*).
    - Stop, a model selector, and a safe Markdown renderer that builds React elements only (no HTML injection).
  - **Sessions.** A menu with "Your chats" and "Shared with the project". New chat; Share or Make private; Rename; Delete. Shared chats are read-only for collaborators, with a banner saying so. The last chat is remembered per project.
  - **Core touch.** Small: `Editor.tsx` (toggle, dock, preview width accounts for the panel), `CodePane.tsx` (`getCursorContext()`), and a `/agent-gateway` proxy in `vite.config.ts`.
  - **Gateway additions.**
    - Session detail includes the tool-activity history.
    - The `error` event is renamed `run_error`, because EventSource reserves `error`.
    - Friendly model labels ("Claude Haiku 5.5").
    - `search_project` reads files over Aldine's 100 KB cap in line windows and skips unreadable files instead of failing. The live run hit this on `IEEEtran.cls`.
  - **Tests.** Web 67/67 (new transcript tests), gateway 30/30, both typechecks clean.

- 2026-10-13 — **Review URL fixed.** The user reported that `:8095` timed out from their machine. Cause: ufw is active and drops non-Docker ports. The dev stack moved into Docker (`deploy/dev-review/`), with source bind-mounted and hot reload. Two follow-up bugs were fixed:
  - containers first ran as uid 1000 (bash's read-only `UID`), so the variables are now `HOST_UID`/`HOST_GID`;
  - the slim Node image had no `git`, which gave "Project not found", so the Aldine container now uses `node:22-bookworm`.
  - The Vite proxy target is now configurable (`ALDINE_DEV_API`), and `/mcp` is proxied too, so Claude Code can connect through the review URL.

### In progress
- Phase 4: `propose_patch` and a diff card with Accept / Edit / Reject; anchor rebase, then apply, then auto-compile; the `X-Aldine-Agent-Label` attribution core change; a Playwright e2e test with the mock provider.

### Blocked
- Nothing.

### Next
- Phase 3, then Phase 4 (`propose_patch`, Accept / Edit / Reject, the attribution core change).

## Dev environment (this host)
- Aldine dev server: `~/dev/aladine-devdata/run-aldine.sh`, on `127.0.0.1:3000` with auth and MCP on. Data lives in `~/dev/aladine-devdata/` (outside the repo). Rate limits are relaxed for development.
- Compiler: the `aladine-dev-compiler` container (`ghcr.io/trahloff/aldine-compiler:0.11.0`, 5 GB), on `127.0.0.1:4020`. It runs as the host user (`--user $(id -u)`) so it can write to the host data directory, with capabilities dropped, a 2 GB memory limit and 256 PIDs.
- Gateway: `cd agent-gateway && npm run dev`, on `127.0.0.1:3300` under `/agent-gateway`.

## Reconnaissance notes

See [`agent-gateway/DESIGN.md`](agent-gateway/DESIGN.md) §1 (facts, with file:line refs) and §2 (proposed design).

## Visual verification log

- **2026-10-13, Phase 3 panel**, at `http://10.211.108.8:8095` (test project), driven by `e2e/assistant-shots.mjs`. Screenshots are in `~/dev/aladine-devdata/shots/` (not committed, because they show the unpublished paper).
  - `panel-empty-light.png` / `panel-empty-dark.png`: empty state with suggestions and the context chip. Matches Aldine's header, buttons, inputs and violet agent mark in both themes.
  - `panel-running.png` / `panel-answer-light.png`: a real Claude Haiku 5.5 run on the paper ("do all `\ref` targets have labels + three contributions"). It made 8 tool calls with live activity lines, one red failure (the 100 KB cap, since fixed), and gave a correct formatted answer.
  - `panel-reopened-dark.png`: the chat reopened from the session menu. History is restored, and Details show the exact tool input and result.
  - `panel-phone.png` (390×844): the drawer over the editor, composer visible.
  - Fixed after review: a long chat title wrapped the header onto three rows; the phone drawer pushed the composer below the screen.
