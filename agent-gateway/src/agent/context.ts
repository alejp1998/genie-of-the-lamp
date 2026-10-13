import { z } from 'zod';
import type { AldineApi, ProjectInfo } from '../aldine/types.ts';

/** What only the browser knows. Everything else is fetched from Aldine by the gateway. */
export const ClientContext = z.object({
  branch: z.string().min(1).max(200).default('main'),
  openFile: z.string().max(500).nullish(),
  cursor: z.object({ line: z.number().int().min(1), column: z.number().int().min(0).optional() }).nullish(),
  selection: z.object({
    text: z.string().max(20_000),
    fromLine: z.number().int().min(1),
    toLine: z.number().int().min(1),
  }).nullish(),
  pdfPage: z.number().int().min(1).nullish(),
}).strict();

export type ClientContext = z.infer<typeof ClientContext>;

const EXCERPT_RADIUS = 12;

/**
 * Builds the <editor_context> block prepended to a user message. Fetches are
 * best effort: a missing compile status or unreadable file just leaves that
 * line out, it never blocks the run.
 */
export async function buildContextBlock(opts: {
  aldine: AldineApi;
  token: string;
  project: ProjectInfo;
  ctx: ClientContext;
  signal: AbortSignal;
}): Promise<string> {
  const { aldine, token, project, ctx, signal } = opts;
  const lines: string[] = [];
  lines.push(`project: ${project.name} · branch: ${ctx.branch}${project.rootFile ? ` · root file: ${project.rootFile}` : ''}`);
  if (ctx.openFile) lines.push(`open file: ${ctx.openFile}${ctx.cursor ? ` · cursor at line ${ctx.cursor.line}` : ''}`);
  if (ctx.pdfPage) lines.push(`PDF preview page: ${ctx.pdfPage}`);

  if (ctx.selection?.text) {
    lines.push(`selected text (${ctx.openFile ?? 'open file'}, lines ${ctx.selection.fromLine}–${ctx.selection.toLine}):`);
    lines.push('```latex', ctx.selection.text, '```');
  } else if (ctx.openFile && ctx.cursor) {
    try {
      const from = Math.max(1, ctx.cursor.line - EXCERPT_RADIUS);
      const r = await aldine.callTool(token, 'read_file', {
        project: project.id, branch: ctx.branch, path: ctx.openFile, from_line: from, to_line: ctx.cursor.line + EXCERPT_RADIUS,
      }, { signal, timeoutMs: 15_000 });
      if (typeof r?.content === 'string' && r.content) {
        lines.push(`around the cursor (${ctx.openFile}, lines ${r.from_line ?? from}–${r.to_line ?? ''}):`);
        lines.push('```latex', r.content.replace(/\n$/, ''), '```');
      }
    } catch { /* excerpt is a convenience */ }
  }

  try {
    const s = await aldine.compileStatus(token, project.id, ctx.branch);
    if (s?.running) lines.push('compile: running now');
    else if (!s?.result) lines.push('compile: none yet on this branch');
    else {
      const errs = (s.result.errors ?? []).filter((e: any) => e.type === 'error');
      if (s.result.ok && !errs.length) lines.push('latest compile: succeeded');
      else {
        lines.push(`latest compile: failed with ${errs.length} error${errs.length === 1 ? '' : 's'}${s.result.timedOut ? ' (timed out)' : ''}`);
        for (const e of errs.slice(0, 5)) lines.push(`- ${e.file ?? '?'}:${e.line ?? '?'} ${e.message}`);
      }
    }
  } catch { /* compile status is a convenience */ }

  return `<editor_context>\n${lines.join('\n')}\n</editor_context>`;
}
