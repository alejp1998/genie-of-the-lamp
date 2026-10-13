# Aldine Agent Fork — Progress Log

Running dev log for the MVP in `ALDINE_AGENT_FORK_SPEC.md` (task brief:
`AGENT_TASK_PROMPT.md`). Updated at the end of every work session.

- **Branch:** `agent-fork/mvp` (forked from upstream `main` @ `a64536f`, Aldine 0.11.0)
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

### In progress
- Awaiting confirmation of the design decisions in `agent-gateway/DESIGN.md` §2 before Phase 2.

### Blocked
- Nothing yet. (Anthropic adapter can be built and unit-tested, but live tests need `ANTHROPIC_API_KEY`.)

### Next
- Phase 2 — Gateway skeleton (TS/Fastify, cookie auth, PAT minting, SQLite store, provider adapters, SSE).

## Reconnaissance notes

See [`agent-gateway/DESIGN.md`](agent-gateway/DESIGN.md) §1 (facts, with file:line refs) and §2 (proposed design).

## Visual verification log

_(per UI milestone: date, what was checked, screenshot path)_
