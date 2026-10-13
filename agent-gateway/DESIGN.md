# Agent Gateway — recon findings and proposed design

Phase 1 output (2026-10-13). Facts are from upstream Aldine 0.11.0 @ `a64536f`;
paths are repo-relative. "Proposed" items are open until confirmed in `PROGRESS.md`.

## 1. What Aldine already gives us

### Stack
- `apps/server`: Fastify, with Hocuspocus/Yjs collaboration on `/collab`. Each project is its own git repo, with a git worktree per branch.
- The datastore seam is `apps/server/src/db/`. It defaults to JSON files under `META_DIR` and switches to Postgres when `DATABASE_URL` is set. It has no migration framework.
- `apps/web`: React 19, Vite and CodeMirror 6. Styling is plain global CSS: tokens live in `theme.css`, components in `app.css`. There are no CSS modules and no Tailwind.
- `apps/compiler`: a zero-dependency latexmk wrapper. It has no egress and drops all capabilities in compose.

### Authentication (`apps/server/src/auth.ts`, `authz.ts`)
- Auth is turned on by `AUTH_ENABLED=1`.
  - When it is **off**, every request is anonymous with full access, and `/mcp` accepts only the operator token `ALDINE_MCP_TOKEN`.
- Sessions use the HttpOnly cookie `aldine_session`. It is an opaque ID stored server-side, set with `SameSite=Lax` and `Path=<basePath>`.
- `GET /api/auth/me` returns the current user, or `null`.
- Personal access tokens (PATs, `aldn_…`):
  - Minted with `POST /api/tokens {name, projectIds?, expiresAt?}`. This route accepts **only** a session cookie.
  - A PAT works on `/mcp`, on REST `/api/projects/:id/*` within its project scope, and on `/collab`.
  - The only scope is a project-ID allowlist; there are no read or write scopes.
- Aldine also acts as an OAuth 2.1 server (PKCE, dynamic client registration, `scope=projects`). Registered redirects must be **https or loopback**, so an `http://10.211.108.8` redirect is refused.
- Permissions:
  - The roles are owner, member (an email or ORCID in `share.collaborators`), and "any signed-in user" when the share mode is `link`.
  - Every member can edit; there is no viewer role.
  - `canAccess`, `isMember` and `isOwner` are in `authz.ts`. They are enforced by a global preHandler in `routes.ts:374-427`.

### MCP (`apps/server/src/mcp/`)
- Enabled by `ALDINE_MCP=1`. It runs over Streamable HTTP in **stateless** mode on `POST /mcp`, using SDK 1.30.
- Requests must send `Accept: application/json, text/event-stream`.
- Every tool takes `project` and `branch`, and every result echoes `{branch, head}`.
- Tools and what they do for the gateway:

  | Tool | Use |
  |---|---|
  | `project_structure` | file list, `rootFile`, `contentVersion` |
  | `read_file` | content, `totalLines`, `contentVersion`, `fileVersion` (line ranges, ~100 KB cap) |
  | `edit_file` | quote-anchored `edits[]`, `base_version`, `message`; all-or-nothing |
  | `batch_write` | several files, one commit; all-or-nothing |
  | `write_file` | whole-file replace (new files only for us) |
  | `compile` | structured `errors[{type,file,line,message,context}]`, `logTail`, signed `pdfUrl` |
  | `get_pdf_url`, `list_citations`, `list_labels`, `wordcount`, `references_add`, `commit`, `ping`, `list_projects` | as named |

- Some tools are missing on purpose: search/grep, git status, diff and log. The REST API covers some of these: `GET /log`, `GET /commit/:hash/diff`, `POST /revert`, `GET /agent-activity`.
- **How writes are applied.** `edit_file` and `batch_write` take the repo lock, then:
  1. flush open docs and checkpoint any human typing as an autosave;
  2. apply the edits as a Yjs transaction on the live doc when it is open (`applySuggestionToDoc`, origin `aldine-agent`), or as a splice on disk otherwise;
  3. mark agent presence and signal agent-write, which arms auto-typeset;
  4. commit the delta authored as **`Claude`**.

  This is exactly the safe path an approved patch needs.
- **Concurrency.** A write with `base_version=V` succeeds only if `fileVersion ≤ V ≤ contentVersion`. Otherwise it returns `version_conflict`.
  - These counters live **in process memory**. They reset when Aldine restarts, so any stored proposal is stale after a restart. It has to be regenerated, never forced.
- REST `PUT /file` replaces the whole live doc, which moves collaborators' cursors. It is only safe for new files.

### Agent identity is hard-coded as "Claude"
- Server:
  - `gitops.ts:476` `AGENT_COMMIT_AUTHOR` (used by `commitAgentWriteHeld` and `agentActivitySince`);
  - `collab.ts:553` `AGENT_AWARENESS_USER`;
  - `mcp/tools.ts:999`.
- Web:
  - `HistoryPanel.tsx:60,63`, the violet dot;
  - `Editor.tsx:416`, the session review toast.
- `authorEmail()` derives `<slug>@aldine.local`, so the email address cannot be chosen freely.

### Existing AI and plugins
- `apps/server/src/ai.ts` makes one non-streaming "diagnose compile errors" call. The `plugins/aifix` plugin applies its fixes with a blind whole-file `PUT`.
- Plugins are frontend-only, with no server hooks:
  - Each is an ES module loaded through `plugins/host.ts`.
  - The only UI slot is a **left-sidebar tab** (230px, rendered as vanilla DOM).
  - Plugins have no access to the selection, Yjs or a diff view.
  - This is too narrow for the assistant panel.
- `claude-plugin/aldine/skills/*/SKILL.md` holds ready-made workflow prompts (fix-build, draft-section, bibliography) that can be reused in the gateway's system prompt.

### Frontend extension points
- **Workspace.** `pages/Editor.tsx` is a single 1391-line component with no store. Its layout is a toolbar plus `.workspace`, which contains the sidebar, the editor pane, a `.resizer` and the preview pane.
  - The PDF divider (`Editor.tsx:1191-1228`) is pointer-captured, keyboard-accessible and ARIA-labelled. It is the pattern to copy for the assistant divider.
  - Width math: `clampPdfWidth` reserves 500px for everything else, so it has to account for the assistant's width.
- **Design tokens.**
  - The `--agent` violet (`#6d4fd8` light / `#a78bfa` dark) is reserved for agent UI.
  - `IconSpark` in `components/Icons.tsx`.
  - Building blocks: `.pane__header`, `.btn*`, `.menu*`, `.panel-list`, and `.review__item` cards.
  - Overlays: `Modal`, `useDialogs`, `useToast`.
  - `DiffView` renders unified diffs that carry a `diff --git` header.
- **Editor handle.** `CodePaneHandle` exposes `getSelection(): {from,to,quote}`, `currentLine()` and `insertAtCursor()`. It has no full text or cursor column; these need adding.
  - Selection tooltips can use CodeMirror's `showTooltip`. `.cm-tooltip` is already themed.
- **State available in `Editor.tsx`.**
  - `compile.result.errors` holds `{type, file, line, message}`.
  - The branch comes from `?branch=` and is tracked in `branchRef`.
  - The identity is `useAuth()`.
- **Feature flags.** `localStorage['aldine.experimental.<x>']==='1'`, with enable and disable commands in the palette (`Editor.tsx:842-846`).
- **API calls.**
  - `api.ts` `req()` sends a same-origin `fetch(withBase(url))` with the session cookie.
  - `vite.config.ts` proxies `/api`, `/collab` and the others to `:3000`; dev runs on `:5173`.
- **Mobile.** At ≤640px the sidebar becomes an absolute overlay drawer. The assistant mirrors this as a drawer anchored on the right.

## 2. Revised plan (v2, 2026-10-13)

I reviewed the draft spec and the v1 design above for failure modes. The baseline is unchanged: a separate gateway, Aldine's own MCP server, human-approved writes, and Git provenance. Everything listed here builds on it. The two choices you confirmed (§2.1 rows 4–5) stay as decided.

### 2.1 Changes from the draft, and why

| # | Draft | v2 | Why |
|---|---|---|---|
| 1 | The chat stream is tied to one HTTP request, and cancelling means closing the socket. | A **run is a job on the gateway**. Its events are saved as they happen and streamed over SSE, and a client can reconnect and pick up with `Last-Event-ID`. Cancelling is an explicit `POST /runs/:id/cancel`. | A reload or flaky Wi-Fi no longer kills a run. Collaborators can watch a shared session live. Reverse proxies often don't pass a closed socket on, so cancel-on-disconnect isn't reliable. |
| 2 | The model gets a toolset that can include edits. | The model gets **no write tools at all**: `edit_file`, `write_file` and `batch_write` are never exposed to it. Its only way to change anything is `propose_patch`, which stores a proposal. The patch is applied only from a human HTTP request (`POST /proposals/:id/accept`) that carries the approver's own session. | "Human-approved by default" becomes something the model cannot get around, not just a prompt instruction. |
| 3 | Reject the patch if the document changed at all since the agent read it. | On Accept, **re-read the file and rebase the patch by its anchors**. Each edit is anchored to a quote of the original text, so if every quote is still present exactly once, nobody touched those regions and the patch applies at the fresh `base_version`. If any quote has changed or now appears more than once, the patch is marked **stale** with the reason, and **Regenerate** appears. | In a live co-authored file, the version moves every time someone types. Strict version matching would make nearly every accept fail. Anchor rebasing still never overwrites a collaborator's change, because a changed region no longer matches its quote. |
| 4 | Single-file edits. | A patch is a list of `changes[{path, edits[] \| new_content}]` and is applied all-or-nothing through `batch_write`, as **one commit**. New files are allowed, for example a section in its own file plus its `\input`. | Real tasks span several files, and one commit is one revert. |
| 5 | The frontend sends all the context. | The frontend sends only what the UI alone knows: open file, cursor, selection, PDF page. The gateway fetches the authoritative state itself: compile status and errors (REST `compile-status`), the file tree and the cursor excerpt (MCP). | A client can't spoof the context, payloads stay small, and this matches the spec ("gathered via MCP"). |
| 6 | Compile-repair loops are left to the agent. | After an accept, the gateway **compiles automatically** and posts the result into the session. If the compile fails, the panel offers **"Ask the assistant to fix"**, a new human-triggered turn. There is no autonomous repair loop. | Repair stays bounded and visible, and every write still needs a human click. |
| 7 | Tests not specified. | A deterministic **`mock` provider** replays scripted turns and powers the unit, integration and Playwright e2e suites. Real-model runs are a separate evaluation script. | No API cost, reproducible CI, and it follows AGENTS.md ("every headline feature gets an e2e test"). |
| 8 | Spend limits not specified. | Anthropic **prompt caching** on the system prompt and tools. Each run is capped on iterations (12), wall time (5 min), output tokens, and per-tool timeouts. Token usage and estimated cost are recorded on the run. | Cost and runaway control. |
| 9 | The gateway sits in the npm workspace. | The gateway is a **self-contained package** with its own lockfile and is not a root workspace. It runs on **Node 24 native TypeScript** (type stripping, no build step); `tsc --noEmit` checks types. | No conflicts in upstream's `package-lock.json`, and the container is smaller. |
| 10 | Sequential layers: gateway, then MCP, then UI, then patches, … | **Vertical slices** (§2.4). Each phase ends with something visible at the review URL. | Integration risk shows up early, and you can review each phase live. |
| 11 | No CSRF stance. | Every gateway mutation requires `X-Aladine-Request: 1` (which forces a CORS preflight cross-origin), and requests whose `Sec-Fetch-Site` is not same-origin are refused. Cookies are forwarded to Aldine and never stored or logged. | Defence in depth on top of `SameSite=Lax`. |
| 12 | "Shared" sessions not specified. | Only the **owner** can continue a session or accept or reject its patches. Shared viewers can read it but not act on it, and every view re-checks project access with Aldine using the viewer's own session. | Every action is the act of one person, so attribution stays unambiguous. |

### 2.2 Components

```
agent-gateway/
  src/
    config.ts            env → typed config (providers, limits, Aldine URL, agent label)
    server.ts            Fastify app: routes, auth hook, SSE
    aldine/
      identity.ts        cookie → /api/auth/me (cached ~10 s) and project access check
      tokens.ts          PAT broker: per (user, project), 1 h, reused, revoked on expiry or shutdown
      mcp.ts             MCP client (stateless Streamable HTTP), sends X-Aldine-Agent-Label
      rest.ts            compile-status, log, commit diff (REST with the same PAT)
    store/               SQLite (node:sqlite) behind a Store interface: sessions, messages, runs, events, proposals, audit
    providers/           Provider interface + anthropic.ts, openai-compatible.ts, mock.ts
    agent/
      loop.ts            bounded tool loop that emits run events
      tools.ts           model-facing tools (read-only + propose_patch); arguments validated with zod
      context.ts         builds the per-turn context block
      prompt.ts          system prompt (adapted from claude-plugin skills)
    patches/             anchor validation, unified diff, rebase-on-accept, apply via batch_write
  test/                  node:test: unit tests (mock provider, fake MCP) + integration against a dev Aldine
```

### 2.3 Gateway HTTP API (same origin, under `/agent-gateway/`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/config` | Enabled models, agent label, limits. Contains no secrets. |
| GET / POST | `/projects/:pid/sessions` | List own and shared sessions, or create one (private by default). |
| GET / PATCH / DELETE | `/sessions/:sid` | Messages, proposals and runs; rename or change visibility (owner only). |
| POST | `/sessions/:sid/messages` | `{text, context, model?}` starts a run and returns `{runId}` (`409` if a run is already active). |
| GET | `/runs/:rid/events` | SSE stream of `text`, `tool_start`, `tool_end`, `proposal`, `usage`, `error` and `done` events. Supports `Last-Event-ID`. |
| POST | `/runs/:rid/cancel` | Cancel the run, aborting the provider stream and the in-flight tool call. |
| POST | `/proposals/:id/accept` | `{edited?}` re-validates, rebases, applies through `batch_write`, auto-compiles, and returns `{commit, compile}`. |
| POST | `/proposals/:id/reject` | Marks the proposal rejected; the document is untouched. |

### 2.4 Phases, revised

1. **Recon.** ✅
2. **Gateway core.** Config; Aldine identity, PAT broker and MCP/REST clients; SQLite store; provider adapters (Anthropic, OpenAI-compatible, mock); bounded loop with the read-only tools; run, event, SSE and cancel APIs; audit. Unit tests, plus an integration test against a local Aldine dev server (auth on, MCP on).
3. **Panel walking skeleton.** Right-hand pane with resizer, toggle and the `aldine.experimental.assistant` flag; session list; streaming chat; tool-activity lines and Details; context capture. Served live at `http://10.211.108.8:8095` and checked visually.
4. **Patches and attribution.** `propose_patch`, then the diff card with Accept / Edit / Reject, then rebase and apply, then auto-compile. Core change: `X-Aldine-Agent-Label` in commits and presence, plus the `isAgentAuthor()` predicate. e2e test with the mock provider.
5. **Sessions and polish.** Sharing with the project and its labels; selection actions; mobile drawer; per-project persistence of panel width and open state; "Ask the assistant to fix".
6. **Deliverable.** Compose overlay (app built from this fork's source, gateway, Caddy front proxy; Aldine's volumes and compiler sandbox untouched); `agent-gateway/README.md`; evaluation script for the spec's tasks.
7. **Extended tools** (after the MVP): bibliography search, citation validation, checkpoints, agent history.
