import { z } from 'zod';
import type { AldineApi } from '../aldine/types.ts';
import type { Limits } from '../config.ts';
import type { ToolSpec } from '../providers/types.ts';

/** What one run's tools share: the user's project credential and per-run bookkeeping. */
export interface ToolContext {
  aldine: AldineApi;
  token: string;
  projectId: string;
  branch: string;
  signal: AbortSignal;
  limits: Limits;
  state: RunState;
}

export interface FileRead {
  contentVersion: number;
  fileVersion: number;
  totalLines: number;
}

export interface RunState {
  compiles: number;
  /** Latest versions seen per path; propose_patch anchors against these. */
  reads: Map<string, FileRead>;
  /** Whole-file text fetched during this run (search reuses it). */
  files: Map<string, string>;
}

export const newRunState = (): RunState => ({ compiles: 0, reads: new Map(), files: new Map() });

export interface AgentTool<I = any> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Present-tense progress line shown while the tool runs, e.g. "Reading intro.tex…". */
  activity(input: I): string;
  /** One-line outcome shown when it finishes. */
  summarize(result: any): string;
  run(input: I, ctx: ToolContext): Promise<unknown>;
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

async function wholeFile(ctx: ToolContext, path: string): Promise<string> {
  const hit = ctx.state.files.get(path);
  if (hit !== undefined) return hit;
  const r = await mcp(ctx, 'read_file', { path });
  remember(ctx, path, r);
  const content = typeof r.content === 'string' ? r.content : '';
  ctx.state.files.set(path, content);
  return content;
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
    for (const f of files) {
      if (ctx.signal.aborted) break;
      if (bytes + (f.size ?? 0) > SEARCH_MAX_BYTES) { truncated = true; break; }
      bytes += f.size ?? 0;
      const content = await wholeFile(ctx, f.path);
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
    return { matches, filesMatched: hit.size, filesSearched: files.length, truncated };
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

export const READ_TOOLS: AgentTool[] = [listFiles, readFile, searchProject, getCompileStatus, compile, listCitations, listLabels];

export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.schema) as Record<string, unknown>;
    delete schema.$schema;
    return { name: t.name, description: t.description, inputSchema: schema };
  });
}
