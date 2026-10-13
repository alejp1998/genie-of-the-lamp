import { z } from 'zod';
import { type AldineApi, AldineToolError } from '../aldine/types.ts';
import type { Limits } from '../config.ts';
import { describeFailure, type EditSpec, fileDiff, resolveEdits, spliceEdits } from '../patches/anchors.ts';
import type { ToolSpec } from '../providers/types.ts';
import type { Proposal, ProposalChange } from '../store/types.ts';

/** What one run's tools share: the user's project credential and per-run bookkeeping. */
export interface ToolContext {
  aldine: AldineApi;
  token: string;
  projectId: string;
  branch: string;
  signal: AbortSignal;
  limits: Limits;
  state: RunState;
  /** Stores a reviewable proposal for this run; absent where proposals are not offered. */
  propose?: (draft: ProposalDraft) => Proposal;
}

export interface ProposalDraft {
  toolCallId: string;
  summary: string;
  changes: ProposalChange[];
  diff: string;
  added: number;
  removed: number;
  base: Proposal['base'];
}

export interface FileRead {
  contentVersion: number;
  fileVersion: number;
  totalLines: number;
}

export interface RunState {
  compiles: number;
  proposals: number;
  /** Latest versions seen per path; propose_patch anchors against these. */
  reads: Map<string, FileRead>;
  /** Whole-file text fetched during this run (search reuses it). */
  files: Map<string, string>;
}

export const newRunState = (): RunState => ({ compiles: 0, proposals: 0, reads: new Map(), files: new Map() });

export interface AgentTool<I = any> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Present-tense progress line shown while the tool runs, e.g. "Reading intro.tex…". */
  activity(input: I): string;
  /** One-line outcome shown when it finishes. */
  summarize(result: any): string;
  run(input: I, ctx: ToolContext, call: { id: string }): Promise<unknown>;
}

const TEXT_EXT = /\.(tex|bib|sty|cls|bst|md|txt|cfg|def|ltx|dtx|ins|bbx|cbx|lbx|csv|tsv|json|yaml|yml)$/i;
const SEARCH_MAX_FILES = 200;
const SEARCH_MAX_BYTES = 4_000_000;
const MAX_LINE_CHARS = 400;

function tool<I>(t: AgentTool<I>): AgentTool<I> { return t; }

async function mcp(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  return ctx.aldine.callTool(ctx.token, name, { project: ctx.projectId, branch: ctx.branch, ...args }, { signal: ctx.signal, timeoutMs: ctx.limits.toolTimeoutMs });
}

function remember(ctx: ToolContext, path: string, r: { contentVersion?: number; fileVersion?: number; totalLines?: number }) {
  if (typeof r.contentVersion === 'number' && typeof r.fileVersion === 'number') {
    ctx.state.reads.set(path, { contentVersion: r.contentVersion, fileVersion: r.fileVersion, totalLines: r.totalLines ?? 0 });
  }
}

/** Lines per request when a file is over Aldine's single-read cap (~100 KB). */
const WINDOW_LINES = 1500;

export interface FreshRead {
  content: string;
  contentVersion: number;
  fileVersion: number;
  head: string | null;
}

type Reader = Pick<ToolContext, 'aldine' | 'token' | 'projectId' | 'branch' | 'signal' | 'limits'>;

/** The file as Aldine has it now, whole even past the ~100 KB single-read cap. */
export async function readFresh(ctx: Reader, path: string): Promise<FreshRead> {
  const call = (args: Record<string, unknown>) => ctx.aldine.callTool(ctx.token, 'read_file', { project: ctx.projectId, branch: ctx.branch, path, ...args }, { signal: ctx.signal, timeoutMs: ctx.limits.toolTimeoutMs });
  try {
    const r = await call({});
    return { content: typeof r.content === 'string' ? r.content : '', contentVersion: r.contentVersion, fileVersion: r.fileVersion, head: r.head ?? null };
  } catch (err) {
    if (!(err instanceof AldineToolError) || !/cap|too large|bytes/i.test(err.message)) throw err;
    // Over the read cap: stitch it together from line windows.
    const parts: string[] = [];
    let total = Infinity;
    let last: any = {};
    for (let from = 1; from <= total; from += WINDOW_LINES) {
      last = await call({ from_line: from, to_line: from + WINDOW_LINES - 1 });
      total = typeof last.totalLines === 'number' ? last.totalLines : 0;
      parts.push(typeof last.content === 'string' ? last.content.replace(/\n$/, '') : '');
    }
    return { content: parts.join('\n') + '\n', contentVersion: last.contentVersion, fileVersion: last.fileVersion, head: last.head ?? null };
  }
}

async function wholeFile(ctx: ToolContext, path: string): Promise<string> {
  const hit = ctx.state.files.get(path);
  if (hit !== undefined) return hit;
  const r = await readFresh(ctx, path);
  remember(ctx, path, r);
  ctx.state.files.set(path, r.content);
  return r.content;
}

const errorsBrief = (errors: any[] | undefined, n = 30) => (errors ?? []).slice(0, n).map((e) => ({
  type: e.type, file: e.file ?? null, line: e.line ?? null, message: e.message, ...(e.context ? { context: e.context } : {}),
}));

export const listFiles = tool({
  name: 'list_files',
  description: 'List every file in the project (path, size) with the root .tex file. Use it first to find where content lives.',
  schema: z.object({}).strict(),
  activity: () => 'Listing project files…',
  summarize: (r) => `${r.files?.length ?? 0} files`,
  async run(_input, ctx) {
    const r = await mcp(ctx, 'project_structure', {});
    return { rootFile: r.rootFile, engine: r.engine, files: (r.files ?? []).map((f: any) => ({ path: f.path, size: f.size, ...(f.binary ? { binary: true } : {}) })) };
  },
});

export const readFile = tool({
  name: 'read_file',
  description: 'Read a text file from the project, optionally a line range (1-based, inclusive). Read a file before proposing changes to it; quote its text exactly when you do.',
  schema: z.object({
    path: z.string().min(1).max(500),
    from_line: z.number().int().min(1).optional(),
    to_line: z.number().int().min(1).optional(),
  }).strict(),
  activity: (i) => `Reading ${i.path}…`,
  summarize: (r) => (r.from_line ? `Read ${r.path} (lines ${r.from_line}–${r.to_line} of ${r.totalLines})` : `Read ${r.path} (${r.totalLines} lines)`),
  async run(input, ctx) {
    const r = await mcp(ctx, 'read_file', input);
    remember(ctx, input.path, r);
    if (!input.from_line && !input.to_line && typeof r.content === 'string') ctx.state.files.set(input.path, r.content);
    return { path: r.path ?? input.path, content: r.content, totalLines: r.totalLines, from_line: r.from_line, to_line: r.to_line };
  },
});

export const searchProject = tool({
  name: 'search_project',
  description: 'Search the text files of the project for a phrase or regular expression. Returns matching lines with file and line number. Use it to find where a term, label, citation key or macro is used.',
  schema: z.object({
    query: z.string().min(1).max(200),
    regex: z.boolean().optional(),
    case_sensitive: z.boolean().optional(),
    path_prefix: z.string().max(500).optional(),
    max_results: z.number().int().min(1).max(100).optional(),
  }).strict(),
  activity: (i) => `Searching for “${i.query}”…`,
  summarize: (r) => `Found ${r.matches.length}${r.truncated ? '+' : ''} matches in ${r.filesMatched} files`,
  async run(input, ctx) {
    let re: RegExp;
    try {
      const flags = input.case_sensitive ? 'g' : 'gi';
      re = new RegExp(input.regex ? input.query : input.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
    } catch (e) {
      throw new Error(`Invalid regular expression: ${(e as Error).message}`);
    }
    const max = input.max_results ?? 50;
    const structure = await mcp(ctx, 'project_structure', {});
    const files: { path: string; size: number }[] = (structure.files ?? [])
      .filter((f: any) => f.type !== 'dir' && !f.binary && TEXT_EXT.test(f.path) && (!input.path_prefix || f.path.startsWith(input.path_prefix)))
      .slice(0, SEARCH_MAX_FILES);
    const matches: { path: string; line: number; text: string }[] = [];
    const hit = new Set<string>();
    let bytes = 0;
    let truncated = false;
    const skipped: string[] = [];
    for (const f of files) {
      if (ctx.signal.aborted) break;
      if (bytes + (f.size ?? 0) > SEARCH_MAX_BYTES) { truncated = true; break; }
      bytes += f.size ?? 0;
      let content: string;
      try {
        content = await wholeFile(ctx, f.path);
      } catch (err) {
        if (ctx.signal.aborted) throw err;
        skipped.push(f.path);
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].length > 4000 ? lines[i].slice(0, 4000) : lines[i];
        re.lastIndex = 0;
        if (re.test(line)) {
          hit.add(f.path);
          if (matches.length >= max) { truncated = true; break; }
          matches.push({ path: f.path, line: i + 1, text: line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + '…' : line });
        }
      }
      if (matches.length >= max && truncated) break;
    }
    return { matches, filesMatched: hit.size, filesSearched: files.length - skipped.length, truncated, ...(skipped.length ? { unreadable: skipped } : {}) };
  },
});

export const getCompileStatus = tool({
  name: 'get_compile_status',
  description: 'Get the result of the most recent compile (success, errors with file and line, duration) without compiling again.',
  schema: z.object({}).strict(),
  activity: () => 'Checking the latest compile…',
  summarize: (r) => (!r.result ? 'No compile yet' : r.result.ok ? 'Last compile succeeded' : `Last compile failed with ${r.result.errorsTotal} errors`),
  async run(_input, ctx) {
    const s = await ctx.aldine.compileStatus(ctx.token, ctx.projectId, ctx.branch);
    if (!s?.result) return { running: !!s?.running, result: null };
    const errs = (s.result.errors ?? []).filter((e: any) => e.type !== 'typesetting');
    return {
      running: !!s.running,
      finishedAt: s.finishedAt ?? null,
      result: { ok: !!s.result.ok, timedOut: !!s.result.timedOut, durationMs: s.result.durationMs, errorsTotal: errs.filter((e: any) => e.type === 'error').length, errors: errorsBrief(errs) },
    };
  },
});

export const compile = tool({
  name: 'compile',
  description: 'Compile the project now and return errors and warnings with file and line. Use it to check whether the document builds; it does not change any file.',
  schema: z.object({}).strict(),
  activity: () => 'Compiling…',
  summarize: (r) => (r.ok ? `Compilation succeeded${r.pages ? ` (${r.pages} pages)` : ''}` : `Compilation failed with ${r.errorsTotal} errors`),
  async run(_input, ctx) {
    if (ctx.state.compiles >= ctx.limits.maxCompilesPerRun) {
      throw new Error(`Compile limit for this request reached (${ctx.limits.maxCompilesPerRun}); report what you found instead.`);
    }
    ctx.state.compiles++;
    const r = await mcp(ctx, 'compile', {});
    return { ok: !!r.ok, timedOut: !!r.timedOut, durationMs: r.durationMs, pages: r.pages, errorsTotal: r.errorsTotal ?? 0, warningsTotal: r.warningsTotal ?? 0, errors: errorsBrief(r.errors), hint: r.hint, logTail: r.logTail };
  },
});

export const listCitations = tool({
  name: 'list_citations',
  description: 'List the bibliography entries available in the project (key, title, authors, year, file). Only cite keys that appear here.',
  schema: z.object({}).strict(),
  activity: () => 'Reading the bibliography…',
  summarize: (r) => `${r.citations?.length ?? 0} bibliography entries`,
  async run(_input, ctx) {
    const r = await mcp(ctx, 'list_citations', {});
    return { citations: r.citations ?? [] };
  },
});

export const listLabels = tool({
  name: 'list_labels',
  description: 'List every \\label in the project with its file, for checking \\ref and \\cref targets.',
  schema: z.object({}).strict(),
  activity: () => 'Collecting labels…',
  summarize: (r) => `${r.labels?.length ?? 0} labels`,
  async run(_input, ctx) {
    const r = await mcp(ctx, 'list_labels', {});
    return { labels: r.labels ?? [] };
  },
});

const MAX_PROPOSALS_PER_RUN = 3;
const PATH_OK = (p: string) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').some((seg) => !seg || seg === '..' || seg.startsWith('.'));

const EditInput = z.object({
  quote: z.string().min(8).max(20_000).describe('Exact text currently in the file (at least 8 characters, unique unless occurrence is given)'),
  replacement: z.string().max(50_000).describe('Text that replaces the quote'),
  occurrence: z.number().int().min(1).optional().describe('Which match to replace when the quote appears more than once (1-based)'),
}).strict();

const ChangeInput = z.object({
  path: z.string().min(1).max(500),
  edits: z.array(EditInput).min(1).max(50).optional().describe('Changes to an existing file'),
  new_content: z.string().max(200_000).optional().describe('Full content of a NEW file (not for existing files)'),
}).strict();

export const proposePatch = tool({
  name: 'propose_patch',
  description: 'Propose changes to the project for the user to review. Nothing is written: the user sees a diff and chooses Accept, Edit or Reject. Edit existing files with quote/replacement pairs that quote the current text exactly (read the file first); create a new file with new_content. Group related changes into one proposal with a one-line summary. After proposing, stop and tell the user in one or two sentences what you proposed and why.',
  schema: z.object({
    summary: z.string().min(1).max(160).describe('One line, imperative, e.g. "Close the parenthesis in the update rule"'),
    changes: z.array(ChangeInput).min(1).max(10),
  }).strict(),
  activity: (i) => `Proposing changes to ${[...new Set(i.changes.map((c) => c.path))].join(', ')}…`,
  summarize: (r) => `Proposed changes to ${r.files.join(', ')} (+${r.added} −${r.removed})`,
  async run(input, ctx, call) {
    if (!ctx.propose) throw new Error('Proposals are not available in this context.');
    if (ctx.state.proposals >= MAX_PROPOSALS_PER_RUN) throw new Error(`At most ${MAX_PROPOSALS_PER_RUN} proposals per request; wait for the user to review the ones you made.`);
    const seen = new Set<string>();
    const changes: ProposalChange[] = [];
    const patches: string[] = [];
    const versions: Proposal['base']['versions'] = {};
    let head: string | null = null;
    let added = 0;
    let removed = 0;
    for (const c of input.changes) {
      if (!PATH_OK(c.path)) throw new Error(`"${c.path}" is not a valid project path (relative, no "..", no hidden segments).`);
      if (seen.has(c.path)) throw new Error(`${c.path} appears twice; put all its edits in one change.`);
      seen.add(c.path);
      if ((c.edits === undefined) === (c.new_content === undefined)) throw new Error(`Give ${c.path} either edits (existing file) or new_content (new file), not both or neither.`);
      if (c.edits) {
        const f = await readFresh(ctx, c.path);
        const res = resolveEdits(f.content, c.edits as EditSpec[]);
        if (!res.ok) throw new Error(describeFailure(c.path, res));
        const after = spliceEdits(f.content, c.edits as EditSpec[], res.ranges);
        if (after === f.content) throw new Error(`The edits to ${c.path} change nothing.`);
        const d = fileDiff(c.path, f.content, after);
        versions[c.path] = { contentVersion: f.contentVersion, fileVersion: f.fileVersion };
        head = f.head ?? head;
        changes.push({ path: c.path, kind: 'edit', edits: c.edits });
        patches.push(d.patch);
        added += d.added;
        removed += d.removed;
      } else {
        let exists = false;
        try { await readFresh(ctx, c.path); exists = true; } catch (err) { if (!(err instanceof AldineToolError)) throw err; }
        if (exists) throw new Error(`${c.path} already exists; change it with edits instead of new_content.`);
        const d = fileDiff(c.path, null, c.new_content!);
        changes.push({ path: c.path, kind: 'create', content: c.new_content });
        patches.push(d.patch);
        added += d.added;
      }
    }
    const p = ctx.propose({ toolCallId: call.id, summary: input.summary, changes, diff: patches.join(''), added, removed, base: { head, versions } });
    ctx.state.proposals++;
    return {
      proposal_id: p.id,
      status: 'awaiting_review',
      files: changes.map((c) => c.path),
      added,
      removed,
      note: 'The user now sees this diff with Accept, Edit and Reject. Nothing has changed yet. Do not propose the same change again; end your reply with a short explanation.',
    };
  },
});

export const READ_TOOLS: AgentTool[] = [listFiles, readFile, searchProject, getCompileStatus, compile, listCitations, listLabels];
export const ASSISTANT_TOOLS: AgentTool[] = [...READ_TOOLS, proposePatch];

export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}
