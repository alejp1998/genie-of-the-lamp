import { z } from 'zod';
import type { AldineApi, ProjectInfo } from '../aldine/types.ts';
import type { Block } from '../providers/types.ts';

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

/** What the user attached to a message: project files by path, pasted text, pasted or dropped images. */
export const Attachment = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(500) }).strict(),
  z.object({ kind: z.literal('text'), name: z.string().min(1).max(120), text: z.string().min(1).max(200_000) }).strict(),
  z.object({
    kind: z.literal('image'),
    name: z.string().max(200).default('image'),
    mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
    // ~5 MB decoded, the provider limit per image.
    data: z.string().min(1).max(7_000_000).regex(/^[A-Za-z0-9+/]+=*$/),
  }).strict(),
]);
export type Attachment = z.infer<typeof Attachment>;

export const MAX_IMAGES = 4;
const FILE_BUDGET_CHARS = 80_000;

/** Turns attachments into model-ready blocks. Referenced files are read now, from Aldine, within a size budget. */
export async function attachmentBlocks(opts: {
  attachments: Attachment[];
  read(path: string): Promise<string>;
}): Promise<Block[]> {
  const blocks: Block[] = [];
  let budget = FILE_BUDGET_CHARS;
  for (const a of opts.attachments) {
    if (a.kind === 'file') {
      let body: string;
      try { body = await opts.read(a.path); } catch (err) { body = `(could not read: ${(err as Error).message})`; }
      if (body.length > budget) body = `${body.slice(0, Math.max(0, budget))}\n…[cut: the referenced files exceed ${FILE_BUDGET_CHARS} characters together; read the rest with read_file]`;
      budget -= body.length;
      blocks.push({ type: 'text', meta: 'attachment', attachment: { kind: 'file', name: a.path, path: a.path }, text: `<referenced_file path="${a.path}">\n${body}\n</referenced_file>` });
    } else if (a.kind === 'text') {
      blocks.push({ type: 'text', meta: 'attachment', attachment: { kind: 'text', name: a.name }, text: `<pasted_text name="${a.name.replace(/"/g, "'")}">\n${a.text}\n</pasted_text>` });
    } else {
      blocks.push({ type: 'image', mediaType: a.mediaType, data: a.data, name: a.name });
    }
  }
  return blocks;
}

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
