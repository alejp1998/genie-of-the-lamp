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
}

export interface PageText {
  /** pdf.js page.view: [x0, y0, x1, y1] in PDF units (origin bottom-left). */
  view: number[];
  items: TextItem[];
}

export interface Rect { left: number; top: number; width: number; height: number }
export interface Match { page: number; rects: Rect[] }

/** Collapses runs of whitespace so a query matches across pdf.js' item and line boundaries. */
const norm = (s: string) => s.toLocaleLowerCase();

export function findMatches(pages: PageText[], query: string, max = 1000): Match[] {
  const q = norm(query.trim().replace(/\s+/g, ' '));
  if (!q) return [];
  const out: Match[] = [];
  pages.forEach((page, pi) => {
    // One string per page; each item remembers where it sits in it.
    let full = '';
    const spans: { start: number; end: number; item: TextItem }[] = [];
    for (const item of page.items) {
      const start = full.length;
      full += item.str;
      spans.push({ start, end: full.length, item });
      if (item.hasEOL || (item.str && !/\s$/.test(item.str))) full += ' ';
    }
    const hay = norm(full).replace(/\s/g, ' ');
    const top = page.view[3];
    const left = page.view[0];
    for (let at = hay.indexOf(q); at >= 0 && out.length < max; at = hay.indexOf(q, at + 1)) {
      const end = at + q.length;
      const rects: Rect[] = [];
      for (const s of spans) {
        if (s.end <= at || s.start >= end || !s.item.str.length) continue;
        const a = Math.max(at, s.start) - s.start;
        const b = Math.min(end, s.end) - s.start;
        const [, , c, d, e, f] = s.item.transform;
        const fontH = Math.hypot(c, d) || s.item.height || 10;
        const per = s.item.width / s.item.str.length;
        rects.push({
          left: e - left + a * per,
          top: top - f - fontH * 0.82,
          width: Math.max(1, (b - a) * per),
          height: fontH * 1.05,
        });
      }
      if (rects.length) out.push({ page: pi + 1, rects });
    }
  });
  return out;
}
