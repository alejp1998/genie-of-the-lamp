import { useState } from 'react';
import DiffView from '../components/DiffView';
import WordDiffView from '../components/WordDiffView';
import { openVirtualDoc } from '../components/VirtualDocs';
import type { AcceptParts, Proposal } from './api';

interface Props {
  proposal: Proposal;
  /** Only the person who started the chat decides; collaborators on a shared chat see the outcome. */
  canDecide: boolean;
  onAccept(parts?: AcceptParts): Promise<void>;
  onReject(): Promise<void>;
  /** Sends a follow-up message in this chat. */
  onAsk(text: string): void;
  onShowHistory?(): void;
}

const files = (p: Proposal) => [...new Set(p.changes.map((c) => c.path))].join(', ');

function EditForm({ proposal, onCancel, onSubmit }: { proposal: Proposal; onCancel(): void; onSubmit(parts: AcceptParts): void }) {
  const [edits, setEdits] = useState(() => proposal.changes.map((c) => c.edits?.map((e) => e.replacement) ?? []));
  const [contents, setContents] = useState(() => proposal.changes.map((c) => c.content ?? ''));
  const submit = () => {
    const parts: AcceptParts = { edits: [], contents: [] };
    proposal.changes.forEach((c, ci) => {
      if (c.kind === 'edit') c.edits!.forEach((e, ei) => { if (edits[ci][ei] !== e.replacement) parts.edits!.push({ change: ci, edit: ei, replacement: edits[ci][ei] }); });
      else if (contents[ci] !== c.content) parts.contents!.push({ change: ci, content: contents[ci] });
    });
    onSubmit(parts);
  };
  return (
    <div className="proposal__edit" data-testid="proposal-edit">
      {proposal.changes.map((c, ci) => (
        <div key={ci} className="proposal__edit-file">
          <div className="proposal__path">{c.path}{c.kind === 'create' ? ' (new file)' : ''}</div>
          {c.kind === 'edit'
            ? c.edits!.map((e, ei) => (
              <label key={ei} className="proposal__edit-row">
                <span className="proposal__quote" title={e.quote}>Replaces: {e.quote}</span>
                <textarea
                  className="input proposal__textarea"
                  value={edits[ci][ei]}
                  onChange={(ev) => setEdits((all) => all.map((row, i) => (i === ci ? row.map((v, j) => (j === ei ? ev.target.value : v)) : row)))}
                  rows={Math.min(8, Math.max(2, e.replacement.split('\n').length + 1))}
                  data-testid="proposal-edit-input"
                />
              </label>
            ))
            : (
              <textarea className="input proposal__textarea" value={contents[ci]} onChange={(ev) => setContents((all) => all.map((v, i) => (i === ci ? ev.target.value : v)))} rows={8} />
            )}
        </div>
      ))}
      <div className="proposal__actions">
        <span className="toolbar__spacer" />
        <button className="btn btn--small btn--ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn--small btn--primary" onClick={submit} data-testid="proposal-accept-edited">Accept edited change</button>
      </div>
    </div>
  );
}

export default function ProposalCard({ proposal: p, canDecide, onAccept, onReject, onAsk, onShowHistory }: Props) {
  const [showDiff, setShowDiff] = useState(p.status === 'pending');
  const [editing, setEditing] = useState(false);
  const [byWord, setByWord] = useState(true);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } finally { setBusy(false); } };
  const pending = p.status === 'pending';

  return (
    <div className={`proposal proposal--${p.status}`} data-testid="proposal-card" data-status={p.status}>
      <div className="proposal__head">
        <span className="proposal__label">{p.status === 'applied' ? 'Applied change' : 'Proposed change'}</span>
        <span className="proposal__files" title={files(p)}>{files(p)}</span>
        <span className="proposal__stats"><span className="proposal__add">+{p.added}</span> <span className="proposal__del">−{p.removed}</span></span>
      </div>
      <div className="proposal__summary">{p.summary}</div>
      {p.resolves?.map((r) => (
        <div key={r.commentId} className="proposal__comment" data-testid="proposal-comment">
          <div className="proposal__comment-head">
            Answers <strong>{r.author}</strong>’s comment on <q>{r.quote.length > 80 ? `${r.quote.slice(0, 79)}…` : r.quote}</q>
            {r.done && <span className="proposal__comment-done" data-testid="proposal-comment-done"> · replied and resolved</span>}
            {r.error && <span className="proposal__err"> · {r.error}</span>}
          </div>
          <div className="proposal__reply">Reply: {r.reply}</div>
        </div>
      ))}
      {p.continueAfterReview && p.status === 'pending' && <div className="proposal__note">The assistant continues with the next item after you decide.</div>}

      {showDiff && !editing && (
        <div className="proposal__diff" data-testid="proposal-diff">
          <div className="seg proposal__seg" role="tablist" aria-label="Diff view">
            <button role="tab" aria-selected={byWord} className={`seg__btn${byWord ? ' seg__btn--active' : ''}`} onClick={() => setByWord(true)} data-testid="proposal-diff-words">Words</button>
            <button role="tab" aria-selected={!byWord} className={`seg__btn${!byWord ? ' seg__btn--active' : ''}`} onClick={() => setByWord(false)} data-testid="proposal-diff-lines">Lines</button>
          </div>
          {byWord ? <WordDiffView patch={p.diff} /> : <DiffView patch={p.diff} />}
        </div>
      )}
      {editing && (
        <EditForm proposal={p} onCancel={() => setEditing(false)} onSubmit={(parts) => { setEditing(false); void run(() => onAccept(parts)); }} />
      )}

      {!editing && (
        <div className="proposal__actions">
          <button className="btn btn--small btn--ghost" onClick={() => setShowDiff((v) => !v)} data-testid="proposal-toggle-diff">{showDiff ? 'Hide diff' : 'View diff'}</button>
          <button className="btn btn--small btn--ghost" onClick={() => openVirtualDoc({ id: `diff:${p.id}`, title: `Diff · ${p.summary}`, kind: 'diff', content: p.diff })} data-testid="proposal-open-diff">Open in editor</button>
          <span className="toolbar__spacer" />
          {pending && canDecide && (
            <>
              <button className="btn btn--small btn--ghost" disabled={busy} onClick={() => setEditing(true)} data-testid="proposal-edit-btn">Edit</button>
              <button className="btn btn--small" disabled={busy} onClick={() => run(onReject)} data-testid="proposal-reject">Reject</button>
              <button className="btn btn--small btn--primary" disabled={busy} onClick={() => run(() => onAccept())} data-testid="proposal-accept">
                {busy ? <span className="spinner" /> : null}Accept
              </button>
            </>
          )}
          {pending && !canDecide && <span className="proposal__note">Waiting for the chat owner to review</span>}
        </div>
      )}

      {p.status === 'applying' && <div className="proposal__status"><span className="dot dot--busy" /> Applying…</div>}
      {p.status === 'applied' && (
        <div className="proposal__status" data-testid="proposal-applied">
          <div>
            <span className="dot dot--ok" /> Committed <code className="md__code" data-testid="proposal-commit">{p.commit?.slice(0, 7) ?? '—'}</code> as <strong>{p.author}</strong>{p.edited ? ' (edited before accepting)' : ''}
            {onShowHistory && <> · <button className="proposal__link" onClick={onShowHistory} data-testid="proposal-history">Show in History</button></>}
          </div>
          {!p.compile && <div className="proposal__sub"><span className="dot dot--busy" /> Typesetting…</div>}
          {p.compile?.ok && <div className="proposal__sub" data-testid="proposal-compile-ok"><span className="dot dot--ok" /> Typeset without errors</div>}
          {p.compile && !p.compile.ok && (
            <div className="proposal__sub" data-testid="proposal-compile-failed">
              <span className="dot dot--error" /> Typesetting failed{p.compile.errorsTotal ? ` with ${p.compile.errorsTotal} error${p.compile.errorsTotal === 1 ? '' : 's'}` : ''}
              {p.compile.errors[0] && <span className="proposal__err">{p.compile.errors[0].file ?? ''}{p.compile.errors[0].line ? `:${p.compile.errors[0].line}` : ''} {p.compile.errors[0].message}</span>}
              {canDecide && <button className="btn btn--small" onClick={() => onAsk(`The typeset after accepting “${p.summary}” failed. Look at the errors and propose a fix.`)} data-testid="proposal-ask-fix">Ask the assistant to fix</button>}
            </div>
          )}
        </div>
      )}
      {p.status === 'rejected' && <div className="proposal__status" data-testid="proposal-rejected">Rejected. The document is unchanged.</div>}
      {p.status === 'superseded' && <div className="proposal__status" data-testid="proposal-superseded">Replaced by a newer proposal below. The document is unchanged.</div>}
      {(p.status === 'stale' || p.status === 'failed') && (
        <div className="proposal__status proposal__status--warn" data-testid="proposal-stale">
          <div>Not applied: {p.reason}</div>
          {canDecide && (
            <div className="proposal__actions">
              <span className="toolbar__spacer" />
              <button className="btn btn--small btn--ghost" onClick={() => run(onReject)}>Dismiss</button>
              <button className="btn btn--small" onClick={() => onAsk(`Your proposal “${p.summary}” no longer applies because the file changed. Re-read the file and propose it again.`)} data-testid="proposal-redo">Ask the assistant to redo it</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
