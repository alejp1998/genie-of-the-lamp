/**
 * Text search over pdf.js text content. Pure: takes each page's text items
 * and returns match rectangles in unscaled page coordinates (CSS px at scale
 * 1, origin top-left), so the pane can draw them at any zoom.
 */

export interface TextItem {
  str: string;
  /** pdf.js transform [a, b, c, d, e, f]: e/f are the baseline origin in PDF units. */
  transform: number[];
  width: number;
  height: number;
  hasEOL?: boolean;
  /** CSS font family pdf.js reports for the item (serif, sans-serif, monospace), for measuring. */
  family?: string;
  /** Font ascent and descent as fractions of the font size, when known. */
  ascent?: number;
  descent?: number;
}

export interface PageText {
  /** pdf.js page.view: [x0, y0, x1, y1] in PDF units (origin bottom-left). */
  view: number[];
  items: TextItem[];
}

export interface Rect { left: number; top: number; width: number; height: number }
export interface Match { page: number; rects: Rect[] }

/** Width of `text` in some unit, for a font family: only ratios within one item are used. */
export type Measure = (text: string, family?: string) => number;

/** Without a canvas, every character is as wide as the item's average. */
const uniform: Measure = (text) => text.length;

const SOFT_HYPHEN = /[-\u2010\u00ad]$/;

/**
 * Every occurrence of `query` (case-insensitive, whitespace collapsed) as
 * rectangles in top-left page units. Each character of the page string
 * remembers its item and offset, so ligatures (ﬁ → fi) and words hyphenated
 * across a line break still match, and a match's position inside an item
 * comes from measured text widths rather than an average character width.
 */
export function findMatches(pages: PageText[], query: string, max = 1000, measure: Measure = uniform): Match[] {
  const q = query.normalize('NFKC').toLocaleLowerCase().trim().replace(/\s+/g, ' ');
  if (!q) return [];
  const out: Match[] = [];
  pages.forEach((page, pi) => {
    const chars: string[] = [];
    const src: { item: number; off: number }[] = [];
    const push = (c: string, item: number, off: number) => {
      if (c === ' ' && (!chars.length || chars[chars.length - 1] === ' ')) return;
      chars.push(c);
      src.push({ item, off });
    };
    page.items.forEach((it, k) => {
      const next = page.items[k + 1]?.str ?? '';
      // A word broken across lines: "coordi-" + "nation" reads as one word.
      const joins = !!it.hasEOL && SOFT_HYPHEN.test(it.str) && /^\p{Ll}/u.test(next);
      const n = joins ? it.str.length - 1 : it.str.length;
      for (let o = 0; o < n; o++) {
        for (const c of it.str[o].normalize('NFKC').toLocaleLowerCase()) push(/\s/.test(c) ? ' ' : c, k, o);
      }
      if (!joins && (it.hasEOL || (it.str && !/\s$/.test(it.str)))) push(' ', k, it.str.length);
    });
    const hay = chars.join('');
    const top = page.view[3];
    const left = page.view[0];
    for (let at = hay.indexOf(q); at >= 0 && out.length < max; at = hay.indexOf(q, at + 1)) {
      const spans = new Map<number, { a: number; b: number }>();
      for (let i = at; i < at + q.length; i++) {
        const { item, off } = src[i];
        const it = page.items[item];
        if (off >= it.str.length) continue; // the space between items
        const sp = spans.get(item);
        if (sp) { sp.a = Math.min(sp.a, off); sp.b = Math.max(sp.b, off + 1); } else spans.set(item, { a: off, b: off + 1 });
      }
      const rects: Rect[] = [];
      for (const [k, { a, b }] of spans) {
        const it = page.items[k];
        const [, , c, d, e, f] = it.transform;
        const fontH = Math.hypot(c, d) || it.height || 10;
        const full = measure(it.str, it.family) || it.str.length;
        const x0 = (measure(it.str.slice(0, a), it.family) / full) * it.width;
        const x1 = (measure(it.str.slice(0, b), it.family) / full) * it.width;
        const ascent = it.ascent && it.ascent > 0.3 ? it.ascent : 0.82;
        const descent = it.descent && it.descent < 0 ? -it.descent : 0.23;
        rects.push({ left: e - left + x0, top: top - f - fontH * ascent, width: Math.max(1, x1 - x0), height: fontH * (ascent + descent) });
      }
      if (rects.length) out.push({ page: pi + 1, rects });
    }
  });
  return out;
}

/**
 * Roughly the text LaTeX source prints, for finding it in the PDF's text
 * layer: comments, citations, references, labels and math go (they print as
 * numbers or symbols), formatting commands keep their argument, dashes and
 * quotes become the glyphs pdf.js reports.
 */
export function latexToPlain(src: string): string {
  let s = src.replace(/(^|[^\\])%.*$/gm, '$1');
  s = s.replace(/\\(?:[A-Za-z]*cite[A-Za-z]*|ref|eqref|cref|Cref|autoref|pageref|label|footnote|url|href)\*?(?:\[[^\]]*\])*\{[^}]*\}/g, ' ');
  s = s.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)/g, ' ');
  for (let i = 0; i < 3; i++) s = s.replace(/\\[A-Za-z@]+\*?(?:\[[^\]]*\])?\{([^{}]*)\}/g, '$1');
  s = s.replace(/\\[A-Za-z@]+\*?/g, ' ').replace(/\\(.)/g, '$1');
  s = s.replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”').replace(/~/g, ' ');
  return s.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim();
}

export interface Region { left: number; top: number; right: number; bottom: number }

/** Every match of `query` on one page that touches one of `boxes` (reading order). */
export function matchesInBoxes(page: PageText, query: string, boxes: Region[], pageNo = 1, measure?: Measure): Match[] {
  const hit = (r: Rect) => boxes.some((b) => r.left + r.width >= b.left - 2 && r.left <= b.right + 2 && r.top + r.height >= b.top - 2 && r.top <= b.bottom + 2);
  return findMatches([page], query, 1000, measure).filter((m) => m.rects.some(hit)).map((m) => ({ ...m, page: pageNo }));
}

/**
 * The occurrence-th match of `query` across the pages a source line typeset
 * to (each with its SyncTeX boxes), counting in reading order; the first one
 * when there are fewer; null when it does not occur there.
 */
export function findInBoxes(pages: PageText[], spots: { page: number; boxes: Region[] }[], query: string, occurrence = 1, measure?: Measure): Match | null {
  const all = spots.flatMap((s) => (pages[s.page - 1] ? matchesInBoxes(pages[s.page - 1], query, s.boxes, s.page, measure) : []));
  return all[occurrence - 1] ?? all[0] ?? null;
}
