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
  await expect(page.getByTestId('assistant-send')).toBeVisible({ timeout: 30_000 }); // run finished
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
  await bob.getByTestId('assistant-toggle').waitFor();
  if (!(await bob.getByTestId('assistant-panel').isVisible())) await bob.getByTestId('assistant-toggle').click();
  await bob.getByTestId('assistant-session-menu').click();
  await bob.getByTestId('assistant-session-list').getByText('Secret draft question').click();
  await expect(bob.getByTestId('assistant-readonly')).toContainText('Shared by Alice');
  await expect(bob.getByTestId('assistant-input')).toHaveCount(0);
  await alice.close();
  await bob.close();
});
