# Genie Agent Gateway

The service behind the assistant panel in Genie. It authenticates Aldine users, runs a bounded tool-using agent against Aldine's own MCP server with a short-lived credential scoped to the user and the project, and streams the work to the browser. Every change it suggests is a proposal that a person accepts, edits or rejects; accepted changes become Git commits authored as `<user> (via Paper Assistant)`.

- [Run Aldine, its compiler and the gateway together](#run-aldine-its-compiler-and-the-gateway-together)
- [Configuration](#configuration)
- [Claude Code and other MCP clients](#claude-code-and-other-mcp-clients)
- [How it works](#how-it-works)
- [Security model](#security-model)
- [Development and tests](#development-and-tests)
- [Operations](#operations)

## Run Aldine, its compiler and the gateway together

You need Docker with Compose v2.24 or newer (the overlay uses `!reset`).

```bash
git clone git@github.com:alejp1998/genie-of-the-lamp.git && cd genie-of-the-lamp

# 1. Provider key and model (kept on the server, never sent to the browser)
cp agent-gateway/.env.example agent-gateway/.env
$EDITOR agent-gateway/.env            # set ANTHROPIC_API_KEY, or a LOCAL_LLM_BASE_URL

# 2. Build and start: Aldine app (built from this repository), the sandboxed
#    TeX Live compiler, the Agent Gateway, and a Caddy front on one origin
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build

# 3. Open it
xdg-open http://localhost:8080        # sign up; the first account is an ordinary user
```

The overlay leaves Aldine's own compose file as it is. Its volumes (`aldine-data`, `aldine-secrets`) and the compiler's sandbox (internal network with no egress, all capabilities dropped, memory and PID limits) are untouched. The overlay makes these changes:

| Service | Change |
|---|---|
| `app` | Built from this fork's source, which adds the assistant panel and agent attribution. Auth and MCP are on, and it is no longer published directly. |
| `compiler` | Unchanged. |
| `gateway` | **New.** It listens on the `frontend` network and keeps its SQLite data in the `genie-agent` volume. |
| `front` | **New.** Caddy routes `/agent-gateway/*` to the gateway and everything else to the app. It is the only published port. |

### Address and port

The front proxy binds `127.0.0.1:8080` by default. Two variables change that, either inline or in a `.env` file next to the compose files:

```bash
GENIE_BIND=0.0.0.0 GENIE_PORT=8080 docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d
```

- **Reachable from a private network:** bind to that interface's address, e.g. `GENIE_BIND=10.211.108.8` for ZeroTier. Docker-published ports pass a host firewall such as ufw, while ports opened by plain host processes do not.
- **On the internet:** put TLS in front (Caddy with a domain, or your own proxy). Set `GENIE_PUBLIC_URL=https://latex.example.org` so the cookies are `Secure` and MCP links are absolute.

### Upgrading and stopping

```bash
git pull && docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.agent.yml down      # data stays in the volumes
```

## Configuration

All settings are environment variables in `agent-gateway/.env` (see `.env.example`).

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Enables the `anthropic` provider (vision and native PDF input). |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | — | `openai` provider (Chat Completions). |
| `OPENROUTER_API_KEY` | — | `openrouter` provider. |
| `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, `LOCAL_LLM_VISION` | — | `local`: any OpenAI-compatible endpoint (vLLM, llama.cpp, Ollama, LM Studio). |
| `AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL` | first configured / `claude-haiku-5-5` | The model new messages use. |
| `AGENT_MODELS` | — | Extra models users may pick in the panel, as `provider:model,…`. |
| `AGENT_EFFORT` | `medium` | Anthropic effort: `low`, `medium`, `high`, `xhigh` or `max`. |
| `AGENT_LABEL` / `AGENT_ID` | `Paper Assistant` / `paper-assistant-v1` | Name in commits, replies and presence, and the id in the audit record. |
| `AGENT_MAX_ITERATIONS` | 12 | Model turns per request. |
| `AGENT_RUN_TIMEOUT_MS` | 300000 | Wall time per request. |
| `AGENT_TOOL_TIMEOUT_MS` | 90000 | Per tool call. |
| `AGENT_MAX_OUTPUT_TOKENS` | 32000 | Per model turn. |
| `AGENT_MAX_COMPILES_PER_RUN` | 3 | |
| `AGENT_MAX_TOOL_RESULT_CHARS` | 40000 | Larger tool outputs are clipped before they reach the model. |
| `AGENT_MAX_MESSAGE_CHARS` | 20000 | |
| `ALDINE_URL` | `http://localhost:3000` | Set to `http://app:3000` by the compose overlay. |
| `ALDINE_MCP_TOKEN` | — | Only for an Aldine **without accounts** (`AUTH_ENABLED` off). Set the same value on the app. Every user then acts as the operator, so per-user privacy does not apply. |
| `AGENT_GATEWAY_BASE_PATH` | `/agent-gateway` | Mount point. With `ALDINE_BASE_PATH=/x`, set `/x/agent-gateway` and adjust the Caddyfile. |
| `AGENT_DATA_DIR` | `.data` | SQLite: `gateway.db` (chats, runs, proposals) and `audit.db` (audit log). |
| `AGENT_RESEARCH` | on | `0` removes the research tools (literature search, paper reading, web search, page reading). |
| `AGENT_RESEARCH_EMAIL` | — | Contact address sent to OpenAlex; puts the gateway in its faster "polite pool". |
| `SEARXNG_URL` | `http://searxng:8080` in the overlay | Your own SearXNG with the JSON format on. Unset: no `web_search`. |
| `SEARXNG_SECRET` | placeholder | SearXNG's secret key; set a long random string. |
| `AGENT_FETCH` | on | `0` stops the assistant reading web pages and open-access PDFs. |
| `OPENALEX_BASE_URL` / `ARXIV_BASE_URL` | public APIs | Alternative endpoints, e.g. a mirror or a test server. |

The app side of the overlay sets the Aldine variables it needs:
- `AUTH_ENABLED=1`
- `ALDINE_MCP=1`
- `TRUST_PROXY=1`
- `RL_MCP_BURST=600`, because one gateway carries every user's MCP calls.

## Claude Code and other MCP clients

The assistant panel suits one-at-a-time, reviewed edits. For larger or programmatic work, connect Claude Code (or any MCP client) to the same server:

1. In Genie, open **Account → Agent access** and create a token. Scope it to the projects it should touch.
2. Add the server to Claude Code:

   ```bash
   claude mcp add --transport http genie http://localhost:8080/mcp \
     --header "Authorization: Bearer aldn_…" \
     --header "X-Aldine-Agent-Label: Claude Code"
   ```

3. In a session, ask for the change. Aldine's tools are `project_structure`, `read_file`, `edit_file`, `batch_write`, `compile`, `list_citations`, `list_labels`, `references_add` and the others listed in `docs/AGENT_API.md`.

These writes apply directly; they are not proposals. They merge into the live document, so co-authors see them as they happen, and they commit at once:
- With the `X-Aldine-Agent-Label` header, the commit is authored as **"Ale (via Claude Code)"**.
- Without the header, as **"Claude"**, which is upstream Aldine's behaviour.

Either way they show in History with the agent dot, and the review prompt lets collaborators review or revert them.

## How it works

```
browser ── same origin ──► front (Caddy)
  │  /agent-gateway/*  SSE chat, proposals            │  everything else
  ▼                                                     ▼
gateway ── MCP + REST, Bearer <1 h project-scoped PAT> ─► app (Aldine) ──► compiler
  └── Anthropic / OpenAI-compatible / local model
```

### Identity

The browser's `aldine_session` cookie reaches the gateway because the gateway is on the same origin. The gateway checks it with `GET /api/auth/me` and asks Aldine itself whether the user may open the project. For tool calls it mints a personal access token limited to that one project and valid for 1 hour (`POST /api/tokens`, named "Paper Assistant (auto)"). It reuses the token until near expiry and revokes it when replacing it. The cookie is never stored.

### Runs

A message starts a run, which is a job on the gateway. Its events (text, tool activity, proposals, notices) are saved and streamed over SSE, and the stream resumes after a reconnect. Cancel stops the provider stream and any tool in flight. Each run is bounded: a maximum number of steps, compiles, tool time, run time and result size.

### Tools

Every tool the model gets is read-only or compile-only:
- `list_files`, `read_file`, `search_project`
- `get_compile_status`, `compile`
- `list_citations`, `list_labels`, `list_comments`
- `view_image`

With research on, it also gets tools that reach outside the project, all free and keyless:
- `search_literature`: OpenAlex (about 250 million works, with venues and citation counts) and arXiv, merged and de-duplicated;
- `get_paper`: one work by DOI or arXiv id, optionally reading its open-access full text;
- `web_search`: the general web through the bundled SearXNG (a private metasearch engine; no account, no API key);
- `fetch_url`: the readable text of a page or online PDF, with any scholarly citation metadata.

The panel shows what the assistant consulted as numbered source cards, and a paper card has **Cite**. A proposal can carry `add_references`: on Accept, those entries go through Aldine's `references_add`, which looks each DOI or arXiv id up and writes clean BibTeX to the project's `.bib` before the `\cite` lands. The panel's `/factcheck`, `/references` and `/related` commands, and **Check** on a selection, drive these tools.

**The model has no write tool.** Its only route to a change is `propose_patch`, which validates quote anchors with Aldine's rules against the current text and stores a proposal with a unified diff.

### Accept

Only the chat's owner can accept, and the request carries their session.
1. The gateway re-reads each file and **rebases the patch by its anchors**. If a collaborator changed the quoted text, the proposal turns *stale* instead of overwriting their work.
2. It applies everything through `batch_write`: all-or-nothing, at the version just read, live in open editors. The `X-Aldine-Agent-Label` header makes the commit read `<approver> (via Paper Assistant)`.
3. It compiles. The commit message carries short provenance trailers: session, proposal, model and base revision. The full attribution record goes to the audit log: initiating and approving user, agent id, provider, model, tool calls, base and resulting revisions, commit, visibility and whether the user edited the proposal.

**Edit** lets the user change the replacement text before accepting. **Reject** writes nothing. A newer proposal for the same file replaces an undecided older one.

### Review comments

`list_comments` reads Aldine's Review threads. A proposal can `resolve` comments; on Accept each gets the reply, posted as `<user> (via Paper Assistant)`, and is resolved. With `continue_after_review`, the assistant resumes on its own after each Accept (once the typeset reports) or Reject, so a list of comments is worked through one reviewed proposal at a time. At most 20 runs chain in a row, and typing a message redirects it.

### Context and attachments

The panel sends what only it knows: the open file, cursor, selection and branch. The gateway reads the compile status and the text around the cursor itself.

Users can attach:
- `@` references to project files, read fresh when the message is sent;
- pasted or dropped text files;
- PDFs: native to models that read PDFs, otherwise the text extracted in the browser;
- images, for models with vision.

### Chats

Chats are private to their owner. **Share with project collaborators** makes one read-only for them. Every view re-checks project access with Aldine.

## Security model

- **Keys.** Provider keys live only in the gateway's environment. The browser talks only to the gateway, and responses never include keys or provider internals such as reasoning signatures.
- **Access.**
  - Every request is authenticated against Aldine. Every project route asks Aldine whether this user may open the project, and every Aldine call uses a token scoped to that one project. Aldine enforces permissions server-side, as it does for any client.
  - Mutations require an `X-Genie-Request: 1` header and a same-origin `Sec-Fetch-Site`, on top of `SameSite=Lax` cookies.
- **Writes.** Only a person's Accept writes, and only after anchor and version checks. The audit log (`audit.db`, kept apart from chat content) records every tool call with its tool name, argument hash, status and duration, plus every run, proposal decision, share change and comment answer. Cookies and tokens are redacted from the logs.
- **Limits.** Steps, compiles, tool and run time, result sizes, attachment sizes and counts (4 images up to 5 MB each, 3 PDFs up to 20 MB each), and a bounded chain of automatic continuations.
- **Outbound requests.** The research tools fetch only `http(s)` URLs that resolve to public addresses. The check runs on the address actually connected to, which also defeats DNS rebinding. Redirects are re-checked at every hop, and each request has a 15 s time limit and a 10 MB size limit. Fetched text is labelled to the model as untrusted evidence, never instructions. Only the search queries and URLs leave the server, never project text. SearXNG runs on the internal network and is never published. arXiv requests go one at a time, 3 s apart, as arXiv asks.
- **Compiler.** Unchanged from Aldine: no egress, capabilities dropped, memory and PID limits.

## Development and tests

```bash
cd agent-gateway
npm install
npm test                 # node:test against a fake Aldine (no network, no model)
npm run typecheck
npm run test:it          # against a running Aldine dev server (AUTH_ENABLED=1, ALDINE_MCP=1, a compiler)
npm run smoke            # one real model run through the loop (spends a few cents)
```

From the repository root:

```bash
npm run test:e2e:assistant    # Playwright: Aldine + gateway with the scripted mock model + a same-origin proxy
```

The **mock provider** (`AGENT_ENABLE_MOCK=1`) makes tool calls from directives in the message, for example `[[tool:read_file {"path":"main.tex"}]]`. That keeps the end-to-end tests deterministic and free.

For live development with hot reload, `deploy/dev-review/docker-compose.yml` runs the source tree in containers and publishes only the web UI. Set its machine-specific values in the git-ignored `deploy/dev-review/.env`.

## Operations

- **Health:** `GET /agent-gateway/health`.
- **Data:** chats, runs, events and proposals are in `gateway.db`; the audit log is in `audit.db`. Both live in `AGENT_DATA_DIR` (the `genie-agent` volume). Back it up together with Aldine's volumes.
- **Restarts:** runs that were in flight are marked failed at boot. Aldine's version counters live in memory, so an Aldine restart makes pending proposals re-validate on Accept. The anchor rebase usually still applies them; when it can't, they turn stale and the panel offers to redo them.
- **Cost:** the Anthropic adapter caches the stable prefix (tools, system prompt, prior turns). Token usage is recorded on each run.
