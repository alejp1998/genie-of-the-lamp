import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * The assistant panel end to end, against the scripted mock model: the chat
 * box drives it with `[[tool:name {json}]]` directives, so each test states
 * exactly which tool call the "model" makes.
 */

const INTRO = '\\section{Introduction}\\label{sec:intro}\nSwarm robotics is a field of study.\nWe study multi-robot coordination.\n';
const FILES = {
  'main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{intro}\n\\end{document}\n',
  'intro.tex': INTRO,
};

let n = 0;
async function signUp(request: APIRequestContext, name: string) {
  const email = `${name.toLowerCase()}-${Date.now()}-${n++}@e2e.test`;
  const r = await request.post('/api/auth/register', { data: { email, password: 'correct-horse-battery-9', name } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return email;
}

async function newProject(request: APIRequestContext) {
  const r = await request.post('/api/projects', { data: { name: `Assistant e2e ${n++}`, files: FILES } });
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()).id as string;
}

async function openAssistant(page: Page, projectId: string, file = 'intro.tex') {
  await page.goto(`/p/${projectId}?file=${encodeURIComponent(file)}`);
  await page.getByTestId('editor-shell').waitFor();
  await page.getByTestId('assistant-toggle').click();
  await expect(page.getByTestId('assistant-panel')).toBeVisible();
}

async function ask(page: Page, text: string) {
  await page.getByTestId('assistant-input').fill(text);
  await page.getByTestId('assistant-send').click();
  // Finished when the box is empty again (sent) and no run is live (no Stop, no status line).
  await expect(page.getByTestId('assistant-input')).toHaveValue('');
  await expect(page.getByTestId('assistant-stop')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('assistant-thinking')).toHaveCount(0, { timeout: 30_000 });
}

const patch = (replacement: string) => JSON.stringify({
  summary: 'Tighten the intro sentence',
  changes: [{ path: 'intro.tex', edits: [{ quote: 'Swarm robotics is a field of study.', replacement }] }],
});

async function fileContent(request: APIRequestContext, id: string, path: string) {
  return (await request.get(`/api/projects/${id}/file?path=${encodeURIComponent(path)}&branch=main`)).text();
}

test('chat streams a reply with tool activity and context', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  await expect(page.getByTestId('assistant-empty')).toBeVisible();
  await expect(page.getByTestId('assistant-context')).toContainText('intro.tex');
  await ask(page, 'What is in the intro? [[tool:read_file {"path":"intro.tex"}]]');
  await expect(page.getByTestId('assistant-user-msg')).toContainText('What is in the intro?');
  await expect(page.getByTestId('assistant-tool').first()).toContainText('Read intro.tex (4 lines)');
  await expect(page.getByTestId('assistant-reply').last()).toContainText('Done:');
  // Reload: the chat comes back from the gateway.
  await page.reload();
  await expect(page.getByTestId('assistant-panel')).toBeVisible();
  await expect(page.getByTestId('assistant-tool').first()).toContainText('Read intro.tex');
});

test('a proposed change is reviewed, accepted, committed as "<user> (via Paper Assistant)" and shows in History', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  await ask(page, `Tighten it [[tool:propose_patch ${patch('Swarm robotics studies groups of simple robots.')}]]`);
  const card = page.getByTestId('proposal-card');
  await expect(card).toHaveAttribute('data-status', 'pending');
  // Words view by default: only the changed words are marked.
  await expect(card.locator('ins.wdiff__ins')).toContainText('studies groups of simple robots');
  await expect(card.locator('del.wdiff__del')).toContainText('is a field of study');
  await card.getByTestId('proposal-diff-lines').click();
  await expect(card.getByTestId('proposal-diff')).toContainText('+Swarm robotics studies groups of simple robots.');
  expect(await fileContent(page.request, id, 'intro.tex')).toBe(INTRO); // nothing written yet
  await card.getByTestId('proposal-accept').click();
  await expect(card.getByTestId('proposal-applied')).toContainText('Ada (via Paper Assistant)');
  await expect.poll(() => fileContent(page.request, id, 'intro.tex')).toContain('studies groups of simple robots');
  // Live: the open editor receives the change.
  await expect(page.locator('.cm-content')).toContainText('studies groups of simple robots');
  await card.getByTestId('proposal-history').click();
  const entry = page.locator('.history__item', { hasText: 'Tighten the intro sentence' });
  await expect(entry).toBeVisible();
  await expect(entry).toContainText('Ada (via Paper Assistant)');
  await expect(entry.getByTestId('agent-commit-dot')).toBeVisible();
  const log = await (await page.request.get(`/api/projects/${id}/log?branch=main`)).json();
  expect(log[0]).toMatchObject({ author: 'Ada (via Paper Assistant)' });
  expect(log[0].message).toBe('Tighten the intro sentence');
});

test('reject leaves the file untouched; edit commits the user\'s wording', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  await ask(page, `[[tool:propose_patch ${patch('Rejected wording.')}]]`);
  await page.getByTestId('proposal-reject').click();
  await expect(page.getByTestId('proposal-rejected')).toBeVisible();
  expect(await fileContent(page.request, id, 'intro.tex')).toBe(INTRO);

  await ask(page, `[[tool:propose_patch ${patch('The model wording.')}]]`);
  const card = page.getByTestId('proposal-card').last();
  await card.getByTestId('proposal-edit-btn').click();
  await card.getByTestId('proposal-edit-input').fill('My own wording, edited before accepting.');
  await card.getByTestId('proposal-accept-edited').click();
  await expect(card.getByTestId('proposal-applied')).toContainText('edited before accepting');
  await expect.poll(() => fileContent(page.request, id, 'intro.tex')).toContain('My own wording, edited before accepting.');
});

test('chats are private until shared; a shared chat is read-only for collaborators', async ({ browser }) => {
  const alice = await browser.newPage();
  const bob = await browser.newPage();
  await signUp(alice.request, 'Alice');
  const bobEmail = await signUp(bob.request, 'Bob');
  const id = await newProject(alice.request);
  expect((await alice.request.post(`/api/projects/${id}/share`, { data: { mode: 'private', collaborators: [bobEmail] } })).ok()).toBeTruthy();

  await openAssistant(alice, id);
  await ask(alice, 'Secret draft question');
  await openAssistant(bob, id);
  await bob.getByTestId('assistant-session-menu').click();
  await expect(bob.getByTestId('assistant-session-list')).toContainText('No chats yet');

  await alice.getByTestId('assistant-actions').click();
  await alice.getByTestId('assistant-share-toggle').click();
  await expect(alice.getByTestId('assistant-shared-chip')).toBeVisible();

  await bob.reload();
  await expect(bob.getByTestId('assistant-toggle').or(bob.getByTestId('assistant-panel'))).toBeVisible();
  if (!(await bob.getByTestId('assistant-panel').isVisible())) await bob.getByTestId('assistant-toggle').click();
  await bob.getByTestId('assistant-session-menu').click();
  await bob.getByTestId('assistant-session-list').getByText('Secret draft question').click();
  await expect(bob.getByTestId('assistant-readonly')).toContainText('Shared by Alice');
  await expect(bob.getByTestId('assistant-input')).toHaveCount(0);
  await alice.close();
  await bob.close();
});

/** A one-page PDF with real text, built by hand so the suite needs no TeX. */
function tinyPdf(text: string): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '', // content stream, filled below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 18 Tf 30 120 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DAwMDAxMDAwMAAAA0vAQPd0v8iAAAAAElFTkSuQmCC', 'base64');

async function putBinary(request: APIRequestContext, id: string, path: string, data: Buffer) {
  const r = await request.put(`/api/projects/${id}/file`, { data: { path, content: data.toString('base64'), encoding: 'base64', branch: 'main' } });
  expect(r.ok(), await r.text()).toBeTruthy();
}

test('project images and PDFs open as previews; find works in a PDF', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await putBinary(page.request, id, 'figures/dot.png', PNG);
  await putBinary(page.request, id, 'figures/plot.pdf', tinyPdf('Swarm recall curve'));
  await page.goto(`/p/${id}?file=intro.tex`);
  await page.getByTestId('editor-shell').waitFor();
  await page.getByTestId('source-only').click(); // the tree hides non-source files by default
  await page.getByTestId('file-figures/dot.png').click();
  await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'image');
  await expect(page.getByTestId('file-preview-image')).toBeVisible();
  await page.getByTestId('file-figures/plot.pdf').click();
  await expect(page.getByTestId('file-preview')).toHaveAttribute('data-kind', 'pdf');
  await expect(page.locator('[data-testid="file-preview"] .pdf-page')).toHaveCount(1);
  await page.getByTestId('file-preview-find').click();
  await page.locator('[data-testid="file-preview"] [data-testid="pdf-find-input"]').fill('recall');
  await expect(page.locator('[data-testid="file-preview"] [data-testid="pdf-find-count"]')).toHaveText('1 of 1');
  await expect(page.locator('[data-testid="file-preview"] .pdf-hit')).toHaveCount(1);
  // Back to source: the editor is there again.
  await page.getByTestId('file-intro.tex').click();
  await expect(page.locator('.cm-content')).toContainText('Swarm robotics');
});

test('attachments: pasted text, a dropped file and a PDF reach the model and open as tabs', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  // A long paste becomes an attachment instead of filling the box.
  const long = Array.from({ length: 40 }, (_, i) => `Reviewer note ${i + 1}: the intro is vague.`).join('\n');
  await page.getByTestId('assistant-input').click();
  await page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    document.querySelector('[data-testid=assistant-input]')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, long);
  // Drop a text file and a PDF on the panel.
  await page.evaluate((pdfB64) => {
    const dt = new DataTransfer();
    dt.items.add(new File(['x = 1\nprint(x)\n'], 'check.py', { type: 'text/x-python' }));
    dt.items.add(new File([Uint8Array.from(atob(pdfB64), (c) => c.charCodeAt(0))], 'review.pdf', { type: 'application/pdf' }));
    const el = document.querySelector('[data-testid=assistant-panel]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, tinyPdf('Reviewer two asks for ablations').toString('base64'));
  const chips = page.locator('.assistant__composer [data-testid=assistant-attachment]');
  await expect(chips).toHaveCount(3);
  await expect(chips).toContainText(['Pasted text 1', 'check.py', 'review.pdf']);
  // A binary that is none of these is refused by name.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array([0, 1, 2, 0, 255])], 'blob.bin', { type: 'application/octet-stream' }));
    const el = document.querySelector('[data-testid=assistant-panel]')!;
    for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.getByTestId('assistant-error')).toContainText('blob.bin is not a text file, PDF or image');
  await ask(page, 'Summarize the attachments');
  const sent = page.locator('.assistant__user').last().getByTestId('assistant-attachment');
  await expect(sent).toHaveCount(3);
  // Stored on the gateway: the PDF went with its extracted text.
  const sessions = await (await page.request.get(`/agent-gateway/projects/${id}/sessions`)).json();
  const detail = await (await page.request.get(`/agent-gateway/sessions/${sessions.sessions[0].id}`)).json();
  const blocks = detail.messages[0].blocks;
  expect(blocks.find((b: any) => b.type === 'document')).toMatchObject({ name: 'review.pdf', hasText: true });
  expect(blocks.filter((b: any) => b.attachment?.kind === 'text').map((b: any) => b.attachment.name)).toEqual(['Pasted text 1', 'check.py']);
  // Chips open as read-only tabs beside the file.
  await sent.filter({ hasText: 'check.py' }).locator('.assistant__chip-open').click();
  await expect(page.getByTestId('virtual-doc')).toContainText('print(x)');
  await sent.filter({ hasText: 'review.pdf' }).locator('.assistant__chip-open').click();
  await expect(page.locator('[data-testid=virtual-doc] .pdf-page')).toHaveCount(1);
  await expect(page.getByTestId('vtab')).toHaveCount(2);
  await page.getByTestId('vtab-file').click();
  await expect(page.locator('.cm-content')).toContainText('Swarm robotics');
});

test('@ references and the selection toolbar fill the composer without editing anything', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  await page.getByTestId('assistant-input').pressSequentially('Compare with @mai');
  await expect(page.getByTestId('assistant-file-menu')).toContainText('main.tex');
  await page.getByTestId('assistant-input').press('Enter');
  await expect(page.locator('.assistant__composer [data-testid=assistant-attachment]')).toContainText('main.tex');
  await expect(page.getByTestId('assistant-input')).toHaveValue('Compare with ');
  await page.getByTestId('assistant-input').fill('/imp');
  await expect(page.getByTestId('assistant-slash-menu')).toContainText('/improve');
  await page.getByTestId('assistant-input').press('Enter');
  await expect(page.getByTestId('assistant-input')).toHaveValue(/Improve the wording/);
  // Selection toolbar in the editor.
  await page.locator('.cm-line', { hasText: 'Swarm robotics is a field of study.' }).click({ clickCount: 3 });
  await page.getByTestId('sel-explain').click();
  await expect(page.getByTestId('assistant-input')).toHaveValue('Explain the selected text in plain words.');
  await expect(page.locator('.assistant__composer [data-testid=assistant-attachment]')).toContainText(['intro.tex:2']);
  expect(await fileContent(page.request, id, 'intro.tex')).toBe(INTRO);
});

test('review comments: Comment from the selection toolbar, then the assistant answers it on accept and continues', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  // Leave a comment through the selection toolbar.
  await page.locator('.cm-line', { hasText: 'Swarm robotics is a field of study.' }).click({ clickCount: 3 });
  await page.getByTestId('sel-comment').click();
  await page.getByTestId('comment-body').fill('Too vague: say what is studied.');
  await page.getByTestId('comment-submit').click();
  const comments = await (await page.request.get(`/api/projects/${id}/comments?branch=main`)).json();
  expect(comments).toHaveLength(1);
  const cid = comments[0].id;
  // The (mock) assistant proposes an edit that answers it, continuing afterwards.
  await ask(page, `[[tool:propose_patch ${JSON.stringify({ ...JSON.parse(patch('Swarm robotics studies groups of simple robots.')), resolves: [{ comment_id: cid, reply: 'Made the sentence concrete.' }], continue_after_review: true })}]]`);
  const card = page.getByTestId('proposal-card');
  await expect(card.getByTestId('proposal-comment')).toContainText('Made the sentence concrete.');
  await card.getByTestId('proposal-accept').click();
  await expect(card.getByTestId('proposal-comment-done')).toBeVisible();
  const after = await (await page.request.get(`/api/projects/${id}/comments?branch=main`)).json();
  expect(after[0].resolved).toBe(true);
  expect(after[0].replies[0]).toMatchObject({ author: 'Ada (via Paper Assistant)' });
  expect(after[0].replies[0].body).toMatch(/^Made the sentence concrete\./);
  // Resumed on its own once the typeset reported.
  await expect(page.locator('.assistant__notice--info', { hasText: 'Continued after your review' })).toBeVisible({ timeout: 30_000 });
});

test('double-clicking commented text opens its thread in the Review tab', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  const quote = 'Swarm robotics is a field of study.';
  const from = INTRO.indexOf(quote);
  const made = await page.request.post(`/api/projects/${id}/comments`, { data: { branch: 'main', file: 'intro.tex', anchor: { from, to: from + quote.length, quote }, body: 'Vague.' } });
  const comment = await made.json();
  await page.goto(`/p/${id}?file=intro.tex`);
  await page.locator(`[data-comment-id="${comment.id}"]`).first().dblclick();
  await expect(page.getByTestId('tab-review')).toHaveClass(/sidebar__tab--active/);
  await expect(page.getByTestId(`comment-${comment.id}`)).toHaveClass(/review__item--active/);
});

test('research: literature and web results show as sources; a cited paper lands in the bibliography on accept', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  await ask(page, 'Find work on swarms [[tool:search_literature {"query":"swarm robots"}]] [[tool:web_search {"query":"swarm robotics"}]] [[tool:fetch_url {"url":"http://127.0.0.1:3263/page"}]]');
  const sources = page.getByTestId('assistant-sources').last();
  const paper = sources.getByTestId('assistant-source').filter({ hasText: 'Coordinating Swarms of Simple Robots' });
  await expect(paper).toContainText('Hopper et al. · Journal of Swarm Studies · 2025');
  await expect(paper).toContainText('1,234 citations');
  await expect(sources.getByTestId('assistant-source').filter({ hasText: 'Swarm robotics overview' }).first()).toContainText('127.0.0.1:3263');
  await expect(page.getByTestId('assistant-tool').filter({ hasText: 'Found 1 paper' })).toBeVisible();
  // Cite on a paper card asks the assistant to add and cite it.
  await paper.getByTestId('assistant-source-cite').click();
  await expect(page.getByTestId('assistant-user-msg').last()).toContainText('10.5555/swarm.2025.42');
  await expect(page.getByTestId('assistant-stop')).toHaveCount(0, { timeout: 30_000 });
  // A proposal that adds the reference: on Accept, Aldine writes the BibTeX and reports the key.
  await ask(page, '[[tool:propose_patch {"summary":"Add the swarm reference","changes":[],"add_references":[{"id":"10.5555/swarm.2025.42"}]}]]');
  const card = page.getByTestId('proposal-card').last();
  await expect(card.getByTestId('proposal-reference')).toContainText('Coordinating Swarms of Simple Robots');
  await card.getByTestId('proposal-accept').click();
  await expect(card.getByTestId('proposal-reference')).toContainText('\\cite{');
  await expect(card.getByTestId('proposal-references')).toContainText('Added to the bibliography', { timeout: 30_000 });
  expect(await fileContent(page.request, id, 'references.bib')).toContain('Coordinating Swarms of Simple Robots');
});

test('with the assistant, Cite and Zotero start hidden and the sidebar gear brings them back; Comment lives in the selection toolbar', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  await expect(page.getByTestId('tab-files')).toBeVisible();
  await expect(page.getByTestId('tab-plugin:references')).toHaveCount(0);
  await expect(page.getByTestId('tab-plugin:zotero')).toHaveCount(0);
  await expect(page.getByTestId('add-comment')).toHaveCount(0);
  await page.getByTestId('sidebar-settings').click();
  const settings = page.getByTestId('project-settings');
  await expect(settings.getByTestId('sidebar-tab-settings')).toBeVisible();
  await expect(settings.getByTestId('settings-tab-plugin:zotero')).not.toBeChecked();
  await settings.getByTestId('settings-tab-plugin:references').check();
  await settings.getByTestId('settings-close').click();
  await page.getByTestId('tab-plugin:references').click();
  await expect(page.getByTestId('references-panel')).toBeVisible();
  // The choice is per browser and survives a reload.
  await page.reload();
  await expect(page.getByTestId('tab-plugin:references')).toBeVisible();
  await expect(page.getByTestId('tab-plugin:zotero')).toHaveCount(0);
});

test('the assistant sits below the sidebar tabs by default, and can be a sidebar tab or a pane right of the preview', async ({ page }) => {
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  const sidebar = page.getByTestId('sidebar');
  // Default: below the tabs, files and assistant together; the assistant takes about three quarters.
  await expect(sidebar.getByTestId('assistant-panel')).toBeVisible();
  await expect(page.getByTestId('file-tree')).toBeVisible();
  await expect(page.getByTestId('tab-assistant')).toHaveCount(0);
  await expect(page.getByText('Drop files here to upload')).toHaveCount(0);
  const share = async () => {
    const [p, a] = await Promise.all([sidebar.getByTestId('assistant-panel').boundingBox(), sidebar.boundingBox()]);
    return p!.height / a!.height;
  };
  expect(await share()).toBeGreaterThan(0.65);
  // The divider drags.
  const bar = page.getByTestId('assistant-below-resizer');
  const box = (await bar.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 5 });
  await page.mouse.up();
  expect(await share()).toBeLessThan(0.65);
  // As a sidebar tab: open exactly while its tab is active.
  await page.getByTestId('assistant-place-tab').click();
  await expect(page.getByTestId('tab-assistant')).toHaveClass(/sidebar__tab--active/);
  await page.getByTestId('tab-files').click();
  await expect(page.getByTestId('assistant-panel')).toBeHidden();
  await expect(page.getByTestId('tab-assistant')).not.toHaveClass(/sidebar__tab--active/);
  await page.getByTestId('tab-assistant').click();
  await expect(sidebar.getByTestId('assistant-panel')).toBeVisible();
  // From the header switch straight to the right pane and back to below.
  await page.getByTestId('assistant-place-right').click();
  await expect(page.locator('.assistant-dock').getByTestId('assistant-panel')).toBeVisible();
  await page.locator('.assistant-dock').getByTestId('assistant-place-below').click();
  await expect(sidebar.getByTestId('assistant-panel')).toBeVisible();
  await expect(page.getByTestId('file-tree')).toBeVisible();
  // Right of the preview, from the settings.
  await page.getByTestId('sidebar-settings').click();
  await page.getByTestId('settings-assistant-placement').selectOption('right');
  await page.getByTestId('settings-close').click();
  await expect(page.locator('.assistant-dock').getByTestId('assistant-panel')).toBeVisible();
  await expect(sidebar.getByTestId('assistant-panel')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-resizer')).toHaveCount(0);
  // Remembered per browser.
  await page.reload();
  await expect(page.locator('.assistant-dock').getByTestId('assistant-panel')).toBeVisible();
  // No header button: the right pane hides from its divider and comes back from the window's right edge.
  await expect(page.locator('header [data-testid=assistant-toggle]')).toHaveCount(0);
  await expect(sidebar.getByTestId('assistant-toggle')).toHaveCount(0);
  await page.getByTestId('assistant-collapse').click();
  await expect(page.getByTestId('assistant-panel')).toHaveCount(0);
  await page.locator('.assistant-edge').click();
  await expect(page.locator('.assistant-dock').getByTestId('assistant-panel')).toBeVisible();
});

test('text copied in the editor pastes into the chat box as a file:lines reference, not loose text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signUp(page.request, 'Ada');
  const id = await newProject(page.request);
  await openAssistant(page, id);
  // Lines 2–3 of intro.tex.
  await page.locator('.cm-line', { hasText: 'Swarm robotics is a field of study.' }).click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('ControlOrMeta+c');
  await page.getByTestId('assistant-input').click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByTestId('assistant-input')).toHaveValue('');
  await expect(page.locator('.assistant__composer [data-testid=assistant-attachment]')).toContainText('intro.tex:2–3');
  // Text from elsewhere pastes as usual.
  await page.evaluate(() => navigator.clipboard.writeText('a note from somewhere else entirely'));
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.getByTestId('assistant-input')).toHaveValue('a note from somewhere else entirely');
});
