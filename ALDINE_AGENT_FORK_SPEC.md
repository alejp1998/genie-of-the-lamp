# Aldine Agent Fork: Integrated LLM Assistant for Collaborative LaTeX

## Goal

Fork and extend **Aldine**, the self-hosted, open-source Overleaf alternative, with a deeply integrated LLM agent experience.

The result should feel like Aldine with a native research-writing assistant: collaborators continue writing and reviewing LaTeX in the browser, while any authorized user can chat with an agent that understands the current project, proposes reviewable edits, compiles the document, diagnoses LaTeX errors, and records provenance in Git.

The existing Aldine collaboration core must remain intact and easy to maintain against upstream updates.

## Non-goals

- Do not replace Aldine’s editor, real-time collaboration engine, Git model, compiler, or PDF preview.
- Do not make the browser a direct client of model-provider APIs or raw MCP credentials.
- Do not allow unrestricted shell execution, arbitrary file writes, or autonomous edits without user control.
- Do not build a complex multi-agent orchestration system in the first version.
- Do not make agent edits invisible or difficult to revert.

## Product principles

1. **Aldine first.** The assistant is an additive layer, not a separate product.
2. **Human-approved changes.** The agent may read and analyze freely, but document modifications require explicit approval by default.
3. **Git-native provenance.** Every accepted agent change becomes a reviewable Git commit attributed to the invoking user and agent.
4. **Privacy by default.** Chat sessions are private unless the user explicitly shares them.
5. **Model-agnostic.** The system should support Anthropic, OpenAI, Google, OpenRouter, and local OpenAI-compatible endpoints through configuration and provider adapters.
6. **Simple before clever.** Start with one tool-using agent, a small toolset, bounded loops, and clear evaluation tasks.
7. **Upstream-friendly.** Keep core modifications minimal, isolate new functionality behind clean interfaces, and make generic improvements candidates for upstream contribution.

## Existing Aldine capabilities to preserve

- Browser-based collaborative LaTeX editing.
- Real-time multi-cursor collaboration and presence.
- Projects represented as real Git repositories.
- Branches, commit history, diffs, review, and revert workflows.
- LaTeX compilation and PDF preview.
- Existing MCP endpoint at `/mcp`, which supports reading/editing LaTeX, compiling, inspecting file-and-line errors, and viewing the PDF.
- Existing sharing, authentication, and project-permission concepts.

## Target architecture

```text
Aldine browser UI
├── Collaborative editor
├── File tree
├── PDF preview
├── Git history / branches / diffs
└── Assistant panel (new)
    ├── Chat interface
    ├── Context-aware prompts
    ├── Tool-call progress
    ├── Proposed diffs
    ├── Accept / edit / reject controls
    └── Session visibility controls
              │
              ▼
Agent Gateway (new backend service)
├── Authenticates Aldine users
├── Enforces project-level permissions
├── Manages chat sessions and conversation state
├── Selects relevant project context
├── Calls configured LLM provider
├── Executes MCP tools on behalf of the user
├── Validates and applies approved patches
└── Records audit and attribution metadata
              │
              ▼
Aldine MCP server
├── Read/search project
├── Read files
├── Propose/apply structured patches
├── Compile LaTeX
├── Read compiler errors
├── Read/render PDF
└── Git status / diff / commit
```

## Frontend: Assistant panel

Add a collapsible, resizable right-side panel to the existing Aldine workspace.

```text
┌──────────────────────────────────────────────────────────────┐
│ Project · branch · compile status · collaborators            │
├───────────────────────────────┬──────────────────────────────┤
│ File tree / LaTeX editor      │ Assistant                    │
│                               │ ┌──────────────────────────┐ │
│ Source code                   │ │ Chat and tool activity    │ │
│                               │ │ Proposed diff             │ │
├───────────────────────────────┤ │ Compile result / PDF      │ │
│ PDF preview                   │ └──────────────────────────────┘ │
└───────────────────────────────┴──────────────────────────────┘
```

### UI requirements

- The panel must match Aldine’s existing typography, spacing, colors, icons, and visual restraint.
- It must be collapsible and resizable; its state should persist per user and project.
- On small screens, it becomes a slide-over drawer.
- The assistant must be visually secondary to writing and collaboration.
- Avoid a separate “AI mode”; the assistant is always available as part of the normal editor.

### Context awareness

When a chat session starts or a message is sent, the frontend should provide the Agent Gateway with:

- Current project ID.
- Current branch.
- Open file and cursor position.
- Selected text, if any.
- Latest compile status and structured errors.
- Relevant PDF page or selected PDF region, if available.
- Recent relevant files or sections, selected through retrieval rather than dumping the entire project.

The user should not need to paste context manually for common tasks.

### Selection actions

When the user selects text in the editor, show lightweight inline actions:

- Explain.
- Improve wording.
- Fix LaTeX.
- Add citation.
- Summarize changes.
- Ask about selection.

Selecting an action opens or focuses the assistant panel with a pre-filled, editable prompt. It must not immediately modify the document.

### Tool activity

Show concise, human-readable progress:

```text
Reading related_work.tex…
Found 2 potentially missing citations.
Proposing patch…
Waiting for approval…
Compiling…
Compilation succeeded.
```

Raw model output, JSON tool arguments, and internal traces should be available only in an expandable “Details” view.

### Proposed edits

For every proposed document change, display:

```text
Proposed change · related_work.tex
+ Adds citation to recent multi-robot survey.
- Replaces vague sentence with a precise claim.

[View diff] [Accept] [Edit] [Reject]
```

Requirements:

- Show a side-by-side or unified diff.
- Allow the user to edit the proposed text before accepting.
- Rejecting must leave the document unchanged.
- Accepting creates a Git commit through Aldine’s normal project workflow.
- After acceptance, show commit hash, author attribution, and links to history and the originating chat session.

## Chat sessions and visibility

Each chat session belongs to one project and one initiating user.

### Visibility modes

| Mode | Who can view | Default |
|---|---|---|
| Private | Initiating user only | Yes |
| Shared with project | All current project collaborators | No |
| Shared with selected collaborators | Explicitly selected users | No |
| Read-only shared | Selected users can inspect, but not continue, the session | Optional |

### Requirements

- Private is the default.
- Sharing must be an explicit user action.
- Shared sessions must be clearly labeled in the session list.
- Collaborators must be able to distinguish their own sessions from shared sessions.
- Private sessions must not expose prompts, model outputs, tool calls, or intermediate reasoning to other collaborators.
- Accepted document changes remain visible through the normal Git history, even if the originating chat remains private.
- The system must retain an audit record for every agent-initiated action.

## Attribution and provenance

Every agent-initiated document change must record:

```json
{
  "project_id": "uuid",
  "session_id": "uuid",
  "initiated_by_user_id": "user-id",
  "agent_id": "paper-assistant-v1",
  "provider": "anthropic",
  "model": "model-id",
  "tool_calls": [],
  "base_revision": "git-sha",
  "resulting_revision": "git-sha",
  "git_commit": "git-sha",
  "visibility": "private | project | selected",
  "created_at": "ISO-8601 timestamp"
}
```

Git commits created by the agent should use an identity of the form:

```text
Ale (via Paper Assistant) <agent+ale@your-lab.example>
```

This preserves both human accountability and machine provenance:

- The human user requested and approved the action.
- The agent/model/session that generated the change is identifiable.
- The change is inspectable and revertible through normal Git history.

## Agent Gateway

Create a separate backend service, preferably as an additional container, rather than embedding model-provider logic into Aldine’s core.

### Responsibilities

- Authenticate the Aldine user.
- Verify that the user has permission to read, edit, compile, or manage the target project.
- Create and retrieve chat sessions.
- Manage conversation history and context windows.
- Route requests to the selected model provider.
- Execute tools through Aldine’s MCP server.
- Enforce tool-call limits, timeouts, retry limits, and spend limits.
- Return streaming responses and structured tool events to the frontend.
- Persist audit records and attribution metadata.
- Keep provider API keys server-side.

### Provider configuration

Support configuration through environment variables or an admin settings UI:

```env
AGENT_DEFAULT_PROVIDER=anthropic
AGENT_DEFAULT_MODEL=claude-sonnet-4-5

ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GOOGLE_API_KEY=...
OPENROUTER_API_KEY=...

LOCAL_LLM_BASE_URL=http://vllm:8000/v1
LOCAL_LLM_API_KEY=optional
LOCAL_LLM_MODEL=qwen3-instruct
```

The user-facing model selector may expose only models enabled by the administrator.

Provider support should be implemented through adapters with a common interface:

- Chat completion or streaming chat.
- Native tool/function calling.
- Structured output where available.
- Token usage reporting.
- Error and cancellation handling.

Do not assume every provider has identical tool-calling reliability. The gateway must validate tool calls and recover gracefully from malformed or unsupported responses.

## MCP integration

### Phase 1: reuse existing tools

The Agent Gateway should initially act as an MCP client and reuse Aldine’s existing MCP tools.

Expected baseline capabilities:

- Read project structure.
- Read and search files.
- Read selected files or sections.
- Apply or propose edits.
- Compile the project.
- Read compiler errors with file and line context.
- Read or render the PDF.
- Inspect Git status and diffs.
- Create commits through Aldine’s normal workflow.

### Phase 2: additive MCP extensions

Add MCP tools only when existing tools cannot express a workflow cleanly.

Recommended additions:

- `get_project_context`: returns open file, selection, branch, recent errors, and relevant project metadata.
- `propose_patch`: returns a structured, reviewable diff without applying it.
- `apply_approved_patch`: applies a patch only after explicit user approval and validates the expected base revision.
- `search_bibliography`: searches BibTeX/Zotero entries.
- `validate_citations`: checks citation keys, duplicates, and missing references.
- `create_checkpoint`: creates a named Git checkpoint before a multi-step edit.
- `get_agent_history`: returns prior agent actions for a project or session.

### Tool design rules

- Prefer narrow tools over broad ones.
- Use structured inputs and outputs.
- Return actionable error messages.
- Avoid `run_shell`, unrestricted `write_file`, or tools that bypass Aldine permissions.
- Validate every write against the revision the agent actually read.
- Keep tool schemas small enough to avoid unnecessary prompt overhead.
- Log every tool invocation with user, session, project, tool name, arguments hash, result status, and duration.

## Safe editing workflow

The default workflow for document modification is:

1. User sends a request in the assistant panel.
2. Gateway authenticates the user and checks project permissions.
3. Agent retrieves only relevant project context.
4. Agent proposes a structured patch.
5. Frontend displays the diff.
6. User accepts, edits, or rejects the patch.
7. Accepted patch is committed as `User (via Agent)`.
8. If compilation fails, the agent receives structured errors and may propose another bounded patch.

Low-risk read-only actions may execute automatically:

- Explain a section.
- Search the project.
- Summarize changes.
- Diagnose compiler errors.
- Suggest citations.

Write actions, compilation-triggering changes, bibliography modifications, and changes affecting another collaborator’s section should require explicit approval by default.

## Concurrency and collaboration

Agent edits must coexist safely with live human collaboration.

Requirements:

- Every patch must target the revision the agent read.
- If the document changed before approval, reject or regenerate the patch.
- Use Aldine’s existing real-time state and Git model rather than bypassing it.
- Prevent simultaneous conflicting agent runs on the same project or file unless explicitly designed and tested.
- Show agent presence in the collaborator UI, for example: “Ale via Paper Assistant is editing…”.
- Make every accepted change revertible through Git.
- Never overwrite uncommitted collaborator work silently.

## Security and authorization

- Provider API keys must never be exposed to the browser.
- The frontend communicates only with the Agent Gateway.
- The Agent Gateway communicates with Aldine’s MCP server using delegated, user-scoped credentials.
- Authorization must be enforced server-side, not only in the UI.
- Use short-lived, audience-bound access tokens where applicable.
- Apply least-privilege scopes, for example:
  - `project:read`
  - `project:write`
  - `project:compile`
  - `bibliography:read`
  - `bibliography:write`
- Store audit logs separately from chat content where practical.
- Redact secrets and credentials from logs.
- Isolate LaTeX compilation from the host environment.
- Limit network access from the compilation environment.

## Initial MVP scope

Build the following first:

1. Deploy Aldine locally with its existing MCP server enabled.
2. Add an Agent Gateway service.
3. Add a right-side assistant panel to the frontend.
4. Implement chat streaming and basic conversation history.
5. Support one provider initially, preferably Anthropic, with an adapter interface for others.
6. Reuse existing MCP tools for read, search, compile, and error inspection.
7. Implement `propose_patch` and `apply_approved_patch`.
8. Show reviewable diffs with Accept / Edit / Reject.
9. Attribute accepted commits as `User (via Agent)`.
10. Implement private and project-shared chat sessions.
11. Add basic audit logging.
12. Add bounded tool loops, cancellation, and error handling.

## Acceptance criteria

The MVP is complete when a user can:

- Open a project in Aldine and chat with an assistant without leaving the browser.
- Ask the assistant to explain a section, find issues, or diagnose a compile error.
- Ask for an edit and receive a reviewable diff.
- Accept the diff and see it committed as `User (via Agent)`.
- View the commit in Aldine’s Git history and revert it if needed.
- Compile after an accepted change and inspect the updated PDF.
- Keep a chat session private by default.
- Explicitly share a session with project collaborators.
- See which user initiated each agent action and which agent/model produced it.
- Use a configured model without exposing API keys in the browser.

## Evaluation tasks

Before expanding features, evaluate the assistant on concrete tasks:

- Fix a LaTeX compilation error without deleting valid content.
- Rewrite a paragraph while preserving technical claims and citations.
- Add a citation only when a suitable bibliography entry exists.
- Summarize changes between two Git revisions.
- Explain why a figure or equation is referenced incorrectly.
- Identify inconsistent terminology across sections.
- Produce a section draft from an outline without fabricating references.
- Recover gracefully when compilation fails after a proposed patch.

Measure:

- Task success rate.
- Percentage of proposed patches accepted without manual correction.
- Compile success after accepted edits.
- Incorrect or fabricated citation rate.
- Average tool calls and latency per task.
- Token and cost usage.
- Frequency of unsafe or rejected edits.

## Deployment outline

Run the existing Aldine services plus the new Agent Gateway:

```yaml
services:
  aldine:
    # Existing Aldine web + collaboration service
    # Keep upstream configuration and volumes intact.

  aldine-compiler:
    # Existing LaTeX compilation service/container.

  agent-gateway:
    build: ./agent-gateway
    environment:
      ALDINE_MCP_URL: http://aldine:PORT/mcp
      DATABASE_URL: postgresql://...
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      LOCAL_LLM_BASE_URL: http://vllm:8000/v1
    depends_on:
      - aldine
```

Keep Aldine’s persistent volumes, Git repositories, compiler environment, and database schema untouched wherever possible.

## Implementation sequence

1. **Reconnaissance:** inspect Aldine’s frontend framework, API surface, auth model, MCP tool schemas, and extension points.
2. **Gateway skeleton:** implement auth, project permission checks, session storage, provider adapter, and streaming endpoint.
3. **MCP client:** connect the gateway to Aldine’s MCP server and implement read/search/compile/error tools.
4. **Frontend panel:** add the assistant UI, context injection, streaming chat, and tool activity display.
5. **Patch workflow:** implement structured diffs, approval, application, Git commit, and revert.
6. **Attribution:** add `User (via Agent)` identity and audit metadata.
7. **Sessions:** implement private/project-shared chat sessions and visibility controls.
8. **Extended tools:** add bibliography, citation validation, checkpoints, and history tools only after the MVP is stable.
9. **Evaluation:** run the evaluation tasks and refine prompts, context retrieval, and tool contracts.
