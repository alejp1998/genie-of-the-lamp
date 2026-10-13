// Visual check of the Aladine assistant panel against a running stack.
//   ALADINE_URL=http://10.211.108.8:8095 ALADINE_EMAIL=… ALADINE_PASSWORD=… ALADINE_PROJECT=<id> \
//   ALADINE_ASK="question" OUT=/path/to/dir node e2e/assistant-shots.mjs
// Screens: panel empty (light + dark), a streamed answer, the phone drawer.
// Asking spends model credit; leave ALADINE_ASK empty to skip it.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.ALADINE_URL || 'http://localhost:5173';
const OUT = process.env.OUT || 'e2e/shots/assistant';
const PROJECT = process.env.ALADINE_PROJECT;
const ASK = process.env.ALADINE_ASK || '';
const OPEN_FILE = process.env.ALADINE_OPEN_FILE || '';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
async function session(viewport, theme) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const login = await page.request.post(`${BASE}/api/auth/login`, { data: { email: process.env.ALADINE_EMAIL, password: process.env.ALADINE_PASSWORD } });
  if (!login.ok()) throw new Error(`login failed: ${login.status()} ${await login.text()}`);
  await page.addInitScript((t) => localStorage.setItem('aldine.theme', t), theme);
  await page.goto(`${BASE}/p/${PROJECT}${OPEN_FILE ? `?file=${encodeURIComponent(OPEN_FILE)}` : ''}`);
  await page.getByTestId('editor-shell').waitFor();
  await page.getByTestId('assistant-toggle').waitFor({ timeout: 15_000 });
  return { ctx, page };
}

const shot = async (page, name) => {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('wrote', file);
};

const openPanel = async (page) => {
  if (!(await page.getByTestId('assistant-panel').isVisible().catch(() => false))) await page.getByTestId('assistant-toggle').click();
  await page.getByTestId('assistant-panel').waitFor();
};

for (const theme of ['light', 'dark']) {
  const { ctx, page } = await session({ width: 1600, height: 960 }, theme);
  await openPanel(page);
  await page.getByTestId('assistant-new-chat').click();
  await page.waitForTimeout(1500);
  await shot(page, `panel-empty-${theme}`);
  if (ASK && theme === 'light') {
    await page.getByTestId('assistant-input').fill(ASK);
    await page.getByTestId('assistant-send').click();
    await page.getByTestId('assistant-tool').first().waitFor({ timeout: 60_000 }).catch(() => {});
    await shot(page, 'panel-running');
    await page.getByTestId('assistant-send').waitFor({ timeout: 180_000 });
    await page.waitForTimeout(800);
    await shot(page, 'panel-answer-light');
  }
  await ctx.close();
}

{
  const { ctx, page } = await session({ width: 390, height: 844 }, 'light');
  await openPanel(page);
  await page.waitForTimeout(1200);
  await shot(page, 'panel-phone');
  await ctx.close();
}
await browser.close();
