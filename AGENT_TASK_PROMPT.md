# Agent Task Prompt — Aldine Agent Fork MVP

**Working directory for everything in this task:** `~/dev/aldine_agent_fork/`
(cloned from `trahloff/Aldine`). The full product spec is at
`~/dev/aldine_agent_fork/ALDINE_AGENT_FORK_SPEC.md` (repo root). This prompt
file lives at `~/dev/aldine_agent_fork/AGENT_TASK_PROMPT.md`. All new code,
the gateway service, UI changes, progress log, and compose changes go inside
this folder — do not scatter work across other paths.

Read `ALDINE_AGENT_FORK_SPEC.md` (repo root) and implement the MVP described in
its “Initial MVP scope” section. Before writing any code, first inspect the
Aldine repository: frontend framework, API surface, authentication model, MCP
tool schemas, and extension points.

**Constraint:** Do not modify Aldine’s core collaboration, Git, compiler, or
PDF-preview logic unless strictly necessary. Keep the fork upstream-friendly.

## Implement

1. A separate **Agent Gateway** service (own container, own repo folder
   `agent-gateway/`), never embedding provider keys or model logic in Aldine’s core.
2. A **right-side assistant panel** integrated into the existing Aldine UI,
   collapsible/resizable, matching Aldine’s design language, visually secondary
   to writing and collaboration. No separate “AI mode”.
3. **Streaming chat** with conversation history (persisted per project + user).
4. **Context injection**: open file, cursor, selection, branch, latest compile
   status and structured errors — gathered via MCP, not pasted by the user.
5. **MCP integration**: reuse Aldine’s existing MCP tools for read / search /
   compile / error inspection. Add `propose_patch` / `apply_approved_patch`.
6. **Structured proposed patches** shown as reviewable diffs with
   **Accept / Edit / Reject**. Reject leaves the document untouched.
7. **Attribution**: accepted changes become Git commits authored as
   `User (via Agent)` with audit metadata (session, model, provider,
   base/resulting revisions).
8. **Chat sessions**: private by default; optional explicit sharing with
   project collaborators; shared sessions labeled in the session list.
9. **Gateway hygiene**: audit logging, bounded tool loops (max iterations,
   timeouts), request cancellation, provider configuration via env vars
   (adapter interface; ship one provider, e.g. Anthropic, plus an
   OpenAI-compatible/local endpoint path).

Prioritize a clean, minimal UI that matches Aldine’s existing design language —
no flashy AI chrome. Human-approved changes only, by default.

## Progress tracking

- Maintain a `PROGRESS.md` at the repo root (`~/dev/aldine_agent_fork/PROGRESS.md`):
  a running dev log with **Done / In progress / Blocked / Next** sections,
  updated at the end of every work session, so progress can be tracked from
  outside (including from Telegram via Hermes).
- Commit early and often with clear messages so history reflects progress.

## Live visual verification over ZeroTier

- Serve the frontend dev build (or the composed stack) on a **fixed port bound
  so it is reachable over the ZeroTier network (10.211.108.0/24)** — same
  pattern as our other projects (e.g. `0.0.0.0:<port>` with the port allowed in
  the firewall for the ZeroTier interface only), so the assistant panel can be
  opened from other devices and reviewed live during development.
- Note the chosen URL/port in `PROGRESS.md` and keep it stable across sessions.
- After each UI milestone, verify the panel visually at that URL and record a
  short note (+ screenshot path) in `PROGRESS.md`.

## Deliverable

After implementation, provide **Docker Compose instructions** for running
Aldine, its compiler container, and the Agent Gateway together on a local
server (extend `~/dev/aldine_agent_fork/docker-compose.yml` — keep Aldine's
volumes and compiler sandbox config untouched). Store the final instructions
as `~/dev/aldine_agent_fork/agent-gateway/README.md` and reference them from
`PROGRESS.md`.
