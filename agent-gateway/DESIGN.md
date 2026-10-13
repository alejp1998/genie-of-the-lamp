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

## 2. Proposed design (pending confirmation)

| Concern | Proposal | Core touch |
|---|---|---|
| Browser → gateway routing | The gateway is mounted **same-origin** under `/agent-gateway/` (Vite dev proxy; in compose, a small Caddy front proxy). The browser's `aldine_session` cookie reaches the gateway, and the frontend talks only to the gateway. | none (vite.config adds one proxy line) |
| User authentication | The gateway forwards the cookie to `GET /api/auth/me` (cached for a few seconds). | none |
| User-scoped credential for MCP | The gateway mints a **short-lived, project-scoped PAT** for each (user, project) with the forwarded cookie: `POST /api/tokens {name:"Paper Assistant (auto)", projectIds:[id], expiresAt:+1h}`. It keeps the PAT server-side and in memory only, and re-mints it when it expires. | none |
| Auth-off deployments | Fall back to `ALDINE_MCP_TOKEN`, which is operator-wide. Per-user privacy is then meaningless, so the dev stack runs with `AUTH_ENABLED=1` and password auth. | none |
| `propose_patch` | A **gateway-side** tool that the model sees. It reads the file through MCP, validates the quote anchors and stores the proposal `{path, edits[], base_version, unified diff}`. Nothing is written. | none |
| `apply_approved_patch` | Gateway endpoint called on **Accept**: re-validates ownership + approval, then MCP `edit_file`/`batch_write` with `base_version` and an audit-trailered message. `version_conflict` → mark proposal stale, offer regenerate. | none |
| "User (via Agent)" attribution | A small, isolated server change. A request header on `/mcp`, `X-Aldine-Agent-Label` (for example `Paper Assistant`), makes MCP writes commit as `Ale (via Paper Assistant)` and sets presence to the same label. When the header is absent, behaviour is unchanged (`Claude`). The `=== 'Claude'` checks become one `isAgentAuthor()` predicate (`Claude` or `… (via …)`). Audit metadata goes into git **trailers** (`Agent-Session`, `Agent-Model`, `Agent-Provider`, `Base-Revision`, `Approved-By`). | ~5 files, upstreamable |
| Search | Done in the gateway: `project_structure` plus `read_file`, then a grep in gateway memory, bounded by file count and size. | none |
| Gateway stack | TypeScript, Fastify (same ecosystem as Aldine), the `@modelcontextprotocol/sdk` client and `@anthropic-ai/sdk`. Streaming is SSE over POST. | — |
| Gateway storage | SQLite through `node:sqlite` in its own volume, behind a store interface so Postgres can be added later. Audit records go in a separate table, and can go in a separate file. | — |
| Providers | Adapter interface (`stream(messages, tools, signal)`, which yields text and tool-call events plus usage). It ships with **Anthropic** and **OpenAI-compatible**. The OpenAI-compatible adapter covers the local `llama-router` at `10.211.108.8:11439/v1`, OpenRouter and vLLM. | — |
| Frontend panel | A self-contained `apps/web/src/assistant/` module. `Editor.tsx` only gets a third pane, a resizer and a toolbar toggle. `CodePaneHandle` gains `getCursor()` and `getDocText()`, plus a selection-action tooltip extension. Everything sits behind the `aldine.experimental.assistant` flag until it is stable. | ~3 files touched |
| Live review URL | The composed stack's front proxy is bound to `10.211.108.8:8095` (ZeroTier only, no sudo or firewall changes needed). | — |
