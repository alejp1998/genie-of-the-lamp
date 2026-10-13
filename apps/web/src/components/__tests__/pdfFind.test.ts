import { describe, expect, it } from 'vitest';
import { findMatches, type PageText } from '../pdfFind';

const item = (str: string, x: number, y: number, width: number, hasEOL = false) => ({ str, transform: [10, 0, 0, 10, x, y], width, height: 10, hasEOL });

const pages: PageText[] = [
  { view: [0, 0, 600, 800], items: [item('Swarm robotics studies', 50, 700, 110), item('many simple robots.', 50, 686, 95, true)] },
  { view: [0, 0, 600, 800], items: [item('Robots coordinate locally.', 60, 500, 130)] },
];

describe('findMatches', () => {
  it('finds every case-insensitive occurrence with its page', () => {
    const m = findMatches(pages, 'robot');
    expect(m.map((x) => x.page)).toEqual([1, 1, 2]);
  });

  it('places the rectangle inside the item, measured from the top-left', () => {
    const [first] = findMatches(pages, 'robotics');
    const r = first.rects[0];
    // "Swarm " is 6 of 22 characters at 5 px each.
    expect(r.left).toBeCloseTo(50 + 6 * 5);
    expect(r.width).toBeCloseTo(8 * 5);
    expect(r.top).toBeCloseTo(800 - 700 - 8.2);
  });

  it('matches across items (and across a line break)', () => {
    const m = findMatches(pages, 'studies many');
    expect(m).toHaveLength(1);
    expect(m[0].rects).toHaveLength(2);
  });

  it('ignores blank queries', () => {
    expect(findMatches(pages, '   ')).toEqual([]);
  });
});
