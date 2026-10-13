import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from '../Markdown';

const html = (t: string) => renderToStaticMarkup(<Markdown text={t} />);

describe('chat Markdown links', () => {
  it('renders a link inside bold, opening in a new tab', () => {
    const out = html('1. **[MRPilot: Supervising Teams](https://arxiv.org/abs/2610.07477)** (arXiv, 2026)');
    expect(out).toContain('<strong><a href="https://arxiv.org/abs/2610.07477" target="_blank" rel="noreferrer noopener">MRPilot: Supervising Teams</a></strong>');
  });
  it('links bare URLs without swallowing trailing punctuation', () => {
    const out = html('See https://doi.org/10.1145/3610978.3640723. Or (https://example.org/a_b).');
    expect(out).toContain('<a href="https://doi.org/10.1145/3610978.3640723" target="_blank" rel="noreferrer noopener">https://doi.org/10.1145/3610978.3640723</a>.');
    expect(out).toContain('(<a href="https://example.org/a_b" target="_blank" rel="noreferrer noopener">https://example.org/a_b</a>).');
  });
  it('keeps non-http schemes as text', () => {
    expect(html('[x](javascript:alert(1)) and javascript:alert(1)')).not.toContain('<a');
  });
});
