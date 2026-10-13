/** Particles that belong to a surname ("Geert De Cubber" → "De Cubber"). */
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'den', 'di', 'da', 'das', 'do', 'dos', 'du', 'la', 'le', 'van', 'von', 'ten', 'ter', 'zu', 'al', 'el', 'bin', 'ibn']);

/** A person's surname from BibTeX's "Last, First" or a display name "First Last". */
export function surname(name: string): string {
  const n = name.trim();
  if (n.includes(',')) return n.split(',')[0].trim();
  const parts = n.split(/\s+/);
  let i = parts.length - 1;
  while (i > 1 && PARTICLES.has(parts[i - 1].toLowerCase())) i--;
  if (i === 1 && parts.length > 2 && PARTICLES.has(parts[0].toLowerCase())) i = 0;
  return parts.slice(Math.max(i, parts.length > 1 ? 1 : 0)).join(' ') || n;
}

/** "Smith", "Smith & Lee" or "Smith et al." */
export function authorLine(authors?: string[]): string | null {
  if (!authors?.length) return null;
  if (authors.length === 1) return surname(authors[0]);
  if (authors.length === 2) return `${surname(authors[0])} & ${surname(authors[1])}`;
  return `${surname(authors[0])} et al.`;
}
