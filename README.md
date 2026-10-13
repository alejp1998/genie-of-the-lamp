<div align="center">
    <img src="docs/images/genie-icon.png" alt="Genie of the Lamp icon: a pixel-art genie with glasses rising from a golden lamp marked LaTeX" width="260" height="260">

<picture>
<source media="(prefers-color-scheme: dark)" srcset="docs/images/genie-wordmark-dark.svg">
<img src="docs/images/genie-wordmark-light.svg" alt="GENIE OF THE LAMP" height="48">
</picture>

**Collaborative LaTeX with a research-writing assistant built in. It reads your project, compiles it, diagnoses errors, and proposes edits as reviewable diffs that become Git commits only when you approve them.**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Based on Aldine](https://img.shields.io/badge/Based%20on-Aldine%200.11-orange.svg)](https://github.com/trahloff/Aldine)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6d4fd8.svg)](docs/AGENT_API.md)
[![Default model: Claude Haiku 5.5](https://img.shields.io/badge/Default%20model-Claude%20Haiku%205.5-d97757.svg)](agent-gateway/DESIGN.md)
[![Providers](https://img.shields.io/badge/Providers-Anthropic%20%7C%20OpenAI--compatible%20%7C%20local-3e617d.svg)](agent-gateway/DESIGN.md)
[![Docker Compose](https://img.shields.io/badge/Deploy-Docker%20Compose-2496ED.svg?logo=docker&logoColor=white)](docker-compose.yml)
[![Status: MVP](https://img.shields.io/badge/Status-MVP-6d4fd8.svg)](PROGRESS.md)

*A fork of [Aldine](https://github.com/trahloff/Aldine), the slim, self-hosted Overleaf alternative.*

</div>

---

> **Development status:** the MVP is complete and runs end to end: assistant panel, Agent Gateway, reviewable
> proposals, attribution and review-comment handling. The project is young: interfaces and configuration may
> still change before the first tag. Progress is logged in [PROGRESS.md](PROGRESS.md).

## What is Genie of the Lamp?

Genie of the Lamp ("Genie" for short) is **Aldine with a native research-writing assistant**. Collaborators keep writing and reviewing LaTeX in the browser exactly as before, with real-time multi-cursor editing, Git-native branches, sandboxed ~2 s recompiles and the PDF preview. Any authorized collaborator can also open an assistant panel and chat with an agent that understands the current project.

The assistant runs in a separate **Agent Gateway** service, not inside Aldine's core:

- The browser only talks to the gateway. Provider API keys never reach it.
- The gateway calls the model you configure: Anthropic (default **Claude Haiku 5.5**), any OpenAI-compatible endpoint, or a local model.
- It acts on the project through **Aldine's own MCP server**, using a short-lived credential scoped to that user and that project. Aldine enforces permissions server-side as it does for every other client.

Reading, searching, compiling and diagnosing happen automatically. **Writing does not:** every document change arrives as a structured patch you can **Accept**, **Edit**, or **Reject**. An accepted patch is merged into the live collaborative document, so co-authors see it immediately and nobody's typing is overwritten. It is then committed as **`You (via Paper Assistant)`**, with the session, model, provider and base revision recorded in the commit, where it can be reviewed and reverted from the normal Git history.

```mermaid
flowchart LR
  subgraph Browser["Genie in the browser"]
    E[Editor · file tree · PDF · history]
    P[Assistant panel]
  end
  P -- "SSE chat · same-origin cookie" --> G
  subgraph G["Agent Gateway (new container)"]
    S[Sessions & audit]
    A[Provider adapters]
    T[Tool loop · propose_patch]
  end
  A -- "API key stays here" --> M[(Anthropic / OpenAI-compatible / local LLM)]
  T -- "MCP · user+project-scoped token" --> X
  E <-- "Yjs collab" --> X
  subgraph X["Aldine server (upstream)"]
    MCP["/mcp tools"]
    Git[(Per-project Git)]
  end
  X --> C[Sandboxed TeX Live compiler]
```

## Why "Genie of the Lamp"?

Aldine, the editor underneath, is named after the Aldine Press of Aldus Manutius, the Venetian printer behind italic type and the pocket book. This fork puts a genie in Aldine's lamp, with one change to the story: it grants no wish until you have read the diff. The genie can read, search, compile and explain whenever you ask, but it writes nothing you haven't approved, and every wish it grants is recorded in Git.

## Key features

**Everything Aldine already does** (unchanged, see the [upstream README](https://github.com/trahloff/Aldine#features)):

- ✍️ **Real-time collaboration**: Yjs CRDTs, multi-cursor presence, unlimited collaborators
- 🌿 **Git-native projects**: every project is a real repo with branches, history, diffs, merge and revert, plus GitHub/GitLab/Gitea/Forgejo sync
- ⚡ **Fast, sandboxed compiles**: TeX Live + latexmk with ~2 s warm recompiles in a no-egress container, with errors linked to file and line
- 📚 **References**: native Zotero, DOI/arXiv lookup, citation and label indexes
- 🔌 **MCP endpoint** at `/mcp` for external agents such as Claude Code and claude.ai connectors

**What Genie adds:**

| | Feature |
|---|---|
| 🧞 | **Assistant panel**: a resizable pane next to the PDF, in Aldine's own design language, that becomes a drawer on phones. There is no separate "AI mode". It appears only where an Agent Gateway is deployed. |
| 💬 | **Streaming chat** stored per project and user. Tool activity shows as one line per step (*Reading main.tex… → Read lines 1–120*), with the exact input and result one click away. |
| 🎯 | **Context without copy-paste**: the open file, cursor, selection and branch go with each message, and the gateway fetches compile status and errors itself. |
| 📎 | **Attachments**: `@file` references with autocomplete. Paste or drop any text file, PDF or screenshot: PDFs are read natively by models that support them, and images are seen by vision models. |
| 🖍️ | **Selection toolbar**: Comment · Ask · Explain · Improve · Fix LaTeX · Cite · Check. Each pre-fills an editable prompt with the selection attached; nothing edits the document directly. There are also `/` commands. |
| 🔭 | **Research on free, open sources**: literature search across OpenAlex and arXiv, reading open-access full texts, general web search through a bundled private SearXNG, and reading any link. Answers list their sources as cards, and a paper card has **Cite**. A new reference arrives as reviewable BibTeX in the `.bib` the document loads, together with its `\cite`, in one proposal. `/bibcheck` runs the bibliography through [reffix](https://github.com/kasnerz/reffix) (DBLP) and proposes the fixes. `/factcheck`, `/references` and `/related` commands; **Check** on a selection. No API keys and no paid services. |
| 🧾 | **Reviewable proposals**: word-level diffs (deleted words struck through, inserted words marked), with Accept, Edit and Reject. Each proposal is rebased by its anchors on the current text, so a collaborator's change is never overwritten. A newer proposal replaces an undecided one. |
| 📝 | **Review comments**: the assistant reads Aldine's review threads and handles them one reviewed proposal at a time. On Accept it replies and resolves the thread, then moves on to the next. |
| 🪪 | **Git provenance**: accepted changes commit as `You (via Paper Assistant)`, with session, model and base revision trailers and a full attribution record in the audit log. Claude Code over MCP can commit as `You (via Claude Code)`. |
| 🔒 | **Private by default**: chats can be shared with project collaborators as read-only and are labelled in the session list. |
| 🛡️ | **Gateway hygiene**: an audit log for every tool call and decision; caps on steps, compiles, time and size; cancellation; keys kept on the server. |
| 🔁 | **Model-agnostic**: Anthropic (default Claude Haiku 5.5, with prompt caching), OpenAI, OpenRouter and any OpenAI-compatible or local endpoint. |
| 🔎 | **Editor additions**: Find in PDF (Ctrl/Cmd+F) with highlighted matches; project images and PDFs open as previews; read-only tabs for attachments, tool outputs and diffs; a comment composer that shows the commented lines in context. |

The full product spec is in [ALDINE_AGENT_FORK_SPEC.md](ALDINE_AGENT_FORK_SPEC.md), and the recon findings and gateway design are in [agent-gateway/DESIGN.md](agent-gateway/DESIGN.md).

## Quick start

Aldine, its sandboxed compiler, the Agent Gateway and a same-origin front proxy, built from this repository:

```bash
git clone git@github.com:alejp1998/genie-of-the-lamp.git && cd genie-of-the-lamp
cp agent-gateway/.env.example agent-gateway/.env      # add ANTHROPIC_API_KEY (or a local model URL)
docker compose -f docker-compose.yml -f docker-compose.agent.yml up -d --build
```

Open [localhost:8080](http://localhost:8080), sign up, create or import a project and click **Assistant**. [`agent-gateway/README.md`](agent-gateway/README.md) covers configuration, binding to a network address, TLS, Claude Code over MCP, the security model and operations.

### Aldine only (upstream images, no assistant)

Plain `docker compose up -d` runs upstream Aldine on its own. It is the same as saving this as `docker-compose.yml`:

```yaml
name: aldine

services:
  app:
    image: ghcr.io/trahloff/aldine-app:${ALDINE_VERSION:-0.11.0}
    ports:
      - "8080:3000"
    volumes:
      - aldine-data:/data
      - aldine-secrets:/secrets
    networks: [frontend, backend]
    init: true
    restart: unless-stopped

  compiler:
    image: ghcr.io/trahloff/aldine-compiler:${ALDINE_VERSION:-0.11.0}${ALDINE_TEXLIVE:-}
    volumes:
      - aldine-data:/data
    # The compiler runs untrusted LaTeX. Keep this block.
    networks: [backend]
    mem_limit: 2g
    pids_limit: 256
    cap_drop: [ALL]
    security_opt: [no-new-privileges]
    init: true
    restart: unless-stopped

networks:
  frontend: {}
  backend:
    internal: true # no route to the internet

volumes:
  aldine-data:
  aldine-secrets:
```

Open http://localhost:8080. That's it. Projects live in the `aldine-data`
volume, and everything else (auth, SSO, AI fix, email) is opt-in via
environment variables when you want it.


### Development

```bash
npm install
npm run dev:server     # Aldine API + collab on :3000
npm run dev:web        # Vite on :5173 (proxies to :3000)
docker build -t aldine-compiler apps/compiler
docker run -d -p 4020:4020 -v $PWD/.data:/data aldine-compiler
```

The Aldine test suites work as upstream: `npm run typecheck -w apps/web`, `npm run test -w apps/web`, and `npm run test:e2e`. [AGENTS.md](AGENTS.md) explains the e2e compiler setup.

## Repository layout

| Path | Purpose |
|------|---------|
| `agent-gateway/` | **New.** Agent Gateway service: auth delegation, sessions, provider adapters, MCP client, patch workflow, audit |
| `apps/server/` | Aldine API, Yjs collab, per-project Git, MCP server (`src/mcp/`). Changes here are small and isolated |
| `apps/web/` | Aldine React SPA. The assistant panel lives in `src/assistant/`; editor additions are in `src/components/` (previews, document tabs, find in PDF, word diff) |
| `apps/compiler/` | Sandboxed latexmk wrapper (unchanged) |
| `claude-plugin/` | Claude Code plugin and skills for driving Aldine over MCP |
| `docs/` | Aldine docs (`AGENT_API.md`, `OIDC.md`, `SCALING.md`) plus Genie branding in `docs/images/` |
| `deploy/` | Compose overlays, reverse-proxy samples, cloud stacks; `deploy/agent/` (Caddy front), `deploy/dev-review/` (live-review dev stack) |
| `docker-compose.agent.yml` | Overlay that adds the gateway and front proxy and builds the app from this fork |
| `PROGRESS.md` | Running dev log: Done / In progress / Blocked / Next |

## Staying close to upstream

Genie follows Aldine `main`, which is configured as the `upstream` remote. Collaboration, Git, the compiler and the PDF preview are not forked. New functionality lives in `agent-gateway/` and `apps/web/src/assistant/`. Any change to core code must be small, opt-in, and generic enough to offer upstream, such as attributing MCP writes to a named agent label.

```bash
git fetch upstream && git merge upstream/main
```

## Contributors

- [Alejandro Jarabo-Peñas](https://alejp.me): Genie of the Lamp fork and Agent Gateway
- [Tobias Rahloff](https://github.com/trahloff) and the [Aldine contributors](https://github.com/trahloff/Aldine/graphs/contributors): the editor underneath

## License

[AGPL-3.0-only](LICENSE), the same as Aldine. If you run a modified version as a network service, you must offer its source to its users.

"Aldine" and the Aldine logo are marks of Tobias Rahloff (see [TRADEMARK.md](TRADEMARK.md)). Genie of the Lamp is an independent fork, **based on Aldine**, and is not affiliated with or endorsed by the Aldine project. The wordmark is generated by [`scripts/branding/make_wordmark.py`](scripts/branding/make_wordmark.py) in the pixel style of the [Lyrebird](https://github.com/SDU-UAS-Center/lyrebird) wordmark.

Bug reports and feature requests: [GitHub Issues](https://github.com/alejp1998/genie-of-the-lamp/issues).
