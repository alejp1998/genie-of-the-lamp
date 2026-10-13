import { useState } from 'react';
import { IconDoc, IconLink } from '../components/Icons';
import type { Source } from './api';
import { authorLine } from './names';

const SHOWN = 4;

const host = (url: string) => { try { return new URL(url).host.replace(/^www\./, ''); } catch { return url; } };

/** The papers and pages an answer drew on, numbered in the order the assistant met them. */
export default function Sources({ sources, onCite }: { sources: Source[]; onCite?(s: Source): void }) {
  const [all, setAll] = useState(false);
  if (!sources.length) return null;
  const shown = all ? sources : sources.slice(0, SHOWN);
  return (
    <div className="sources" data-testid="assistant-sources">
      <div className="sources__head">Sources <span className="sources__count">{sources.length}</span></div>
      <ol className="sources__list">
        {shown.map((s, i) => (
          <li key={s.url + i} className={`source source--${s.kind}`} data-testid="assistant-source">
            <span className="source__icon" aria-hidden="true">{s.kind === 'paper' ? <IconDoc /> : <IconLink />}</span>
            <div className="source__main">
              <a className="source__title" href={s.url} target="_blank" rel="noreferrer noopener" title={s.title}>{s.title}</a>
              <div className="source__meta">
                {s.kind === 'paper' ? (
                  <>
                    {[authorLine(s.authors), s.venue, s.year].filter(Boolean).join(' · ')}
                    {typeof s.citedBy === 'number' && <span> · {s.citedBy.toLocaleString()} citation{s.citedBy === 1 ? '' : 's'}</span>}
                    {s.openAccess && <span className="source__oa" title="An open-access copy exists">Open access</span>}
                  </>
                ) : (
                  <>
                    <span>{host(s.url)}</span>
                    {s.snippet && <span className="source__snippet"> · {s.snippet}</span>}
                  </>
                )}
              </div>
            </div>
            {s.kind === 'paper' && (s.doi || s.arxivId) && onCite && (
              <button className="btn btn--ghost btn--small source__cite" onClick={() => onCite(s)} title="Ask the assistant to add this reference and cite it" data-testid="assistant-source-cite">Cite</button>
            )}
          </li>
        ))}
      </ol>
      {sources.length > SHOWN && (
        <button className="assistant__link sources__more" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${sources.length}`}</button>
      )}
    </div>
  );
}
