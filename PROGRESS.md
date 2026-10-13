# Aldine Agent Fork — Progress Log

Running dev log for the MVP in `ALDINE_AGENT_FORK_SPEC.md` (task brief:
`AGENT_TASK_PROMPT.md`). Updated at the end of every work session.

- **Repo:** [github.com/alejp1998/Aladine](https://github.com/alejp1998/Aladine) — work lands on `main`, pushed as we go
  (`upstream` = `trahloff/Aldine`, forked @ `a64536f`, Aldine 0.11.0)
- **Live review URL (ZeroTier):** `http://10.211.108.8:8095` — reserved, not serving yet
  (bound to the ZeroTier IP directly, same pattern as `stt` :9000 and `llama-router` :11439 on this host)
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

### In progress
- Phase 3: the assistant panel (right-hand pane, streaming chat, sessions, context capture), served live on the ZeroTier URL.

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

_(per UI milestone: date, what was checked, screenshot path)_
