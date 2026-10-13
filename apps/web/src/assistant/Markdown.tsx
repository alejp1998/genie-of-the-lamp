import { Fragment, type ReactNode } from 'react';

/**
 * The subset of Markdown models actually write in chat: paragraphs, headings,
 * lists, fenced code, pipe tables, inline code, bold, italics and http(s)
 * links. Builds React elements only, never HTML strings, so model output
 * cannot inject markup.
 */

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))/g;

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k} className="md__code">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    else {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(<a key={k} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
    }
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export default function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i];
    const key = `b${n++}`;
    const fence = /^\s*```(\w+)?\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or end of a still-streaming block)
      blocks.push(<pre key={key} className="md__pre"><code>{body.join('\n')}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(<p key={key} className="md__h">{inline(heading[2], key)}</p>);
      i++;
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key} className="md__tablewrap">
          <table className="md__table">
            <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `${key}h${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, `${key}r${ri}c${j}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }
    const bullet = /^\s*([-*]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (bullet.test(lines[i])) items.push(lines[i].replace(bullet, ''));
        else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={key} className="md__list">{items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</List>);
      continue;
    }
    // The first line always joins, so a stray "| x |" without a table header can't stall the loop.
    const para: string[] = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !bullet.test(lines[i]) && !/^#{1,4}\s/.test(lines[i]) && !isTableRow(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key} className="md__p">{para.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{inline(p, `${key}-${j}`)}</Fragment>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
