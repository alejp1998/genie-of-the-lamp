import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fromAnthropicContent, toAnthropicMessages } from '../src/providers/anthropic.ts';
import { OpenAICompatibleProvider, toOpenAIMessages } from '../src/providers/openai.ts';
import type { ChatMessage } from '../src/providers/types.ts';

const history: ChatMessage[] = [
  { role: 'user', blocks: [{ type: 'text', text: '<editor_context>x</editor_context>', meta: 'context' }, { type: 'text', text: 'fix it' }] },
  {
    role: 'assistant',
    blocks: [
      { type: 'opaque', provider: 'anthropic', model: 'claude-haiku-5-5', data: { type: 'thinking', thinking: '', signature: 'sig' } },
      { type: 'text', text: 'Reading.' },
      { type: 'tool_call', id: 'tu_1', name: 'read_file', input: { path: 'a.tex' } },
    ],
  },
  { role: 'user', blocks: [{ type: 'tool_result', id: 'tu_1', content: '{"content":"x"}' }, { type: 'text', text: 'and also' }] },
];

test('anthropic: thinking blocks replay only to the model that wrote them', () => {
  const same = toAnthropicMessages(history, 'claude-haiku-5-5');
  assert.deepEqual((same[1].content as any[]).map((c) => c.type), ['thinking', 'text', 'tool_use']);
  const other = toAnthropicMessages(history, 'claude-sonnet-5-5');
  assert.deepEqual((other[1].content as any[]).map((c) => c.type), ['text', 'tool_use']);
  assert.deepEqual((same[2].content as any[]).map((c) => c.type), ['tool_result', 'text']);
});

test('anthropic: response content maps to neutral blocks', () => {
  const blocks = fromAnthropicContent([
    { type: 'thinking', thinking: '', signature: 's' } as any,
    { type: 'text', text: 'hi', citations: null } as any,
    { type: 'tool_use', id: 't', name: 'list_files', input: {}, caller: undefined } as any,
  ], 'm');
  assert.deepEqual(blocks.map((b) => b.type), ['opaque', 'text', 'tool_call']);
});

test('openai: tool results follow the assistant tool_calls, user text after them', () => {
  const msgs = toOpenAIMessages('sys', history);
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal((msgs[2] as any).tool_calls[0].function.arguments, '{"path":"a.tex"}');
});

test('openai: parses streamed text, split tool-call arguments and usage', async () => {
  const chunks = [
    { choices: [{ delta: { content: 'Let me ' } }] },
    { choices: [{ delta: { content: 'look.' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_file', arguments: '{"pa' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"main.tex"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', function: { name: 'list_files', arguments: '' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } },
  ];
  let seenBody: any;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seenBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const p = new OpenAICompatibleProvider('local', `http://127.0.0.1:${port}/v1`);
    let streamed = '';
    const r = await p.turn({ model: 'm', system: 's', messages: history, tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }], maxTokens: 100, signal: new AbortController().signal }, { onText: (d) => (streamed += d) });
    assert.equal(streamed, 'Let me look.');
    assert.equal(r.stopReason, 'tool_use');
    assert.deepEqual(r.blocks, [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_call', id: 'call_a', name: 'read_file', input: { path: 'main.tex' } },
      { type: 'tool_call', id: 'call_b', name: 'list_files', input: {} },
    ]);
    assert.equal(r.usage.inputTokens, 120);
    assert.equal(seenBody.tools[0].type, 'function');
    assert.equal(seenBody.stream, true);
  } finally {
    server.close();
  }
});

test('openai: HTTP errors become provider errors, 5xx retryable', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(503); res.end('overloaded'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as { port: number }).port;
    const p = new OpenAICompatibleProvider('local', `http://127.0.0.1:${port}/v1`);
    await assert.rejects(
      p.turn({ model: 'm', system: 's', messages: history, tools: [], maxTokens: 10, signal: new AbortController().signal }, { onText: () => {} }),
      (e: any) => e.name === 'ProviderError' && e.retryable && /503/.test(e.message),
    );
  } finally {
    server.close();
  }
});

test('images: anthropic gets base64 image blocks; OpenAI-compatible gets image_url parts only with vision', async () => {
  const withImage: ChatMessage[] = [{ role: 'user', blocks: [{ type: 'image', mediaType: 'image/png', data: 'AAAA', name: 'shot.png' }, { type: 'text', text: 'what is this?' }] }];
  const a = toAnthropicMessages(withImage, 'm');
  assert.deepEqual((a[0].content as any[])[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  const vision = toOpenAIMessages('s', withImage, true);
  assert.deepEqual((vision[1] as any).content.map((p: any) => p.type), ['text', 'image_url']);
  assert.equal((vision[1] as any).content[1].image_url.url, 'data:image/png;base64,AAAA');
  const blind = toOpenAIMessages('s', withImage, false);
  assert.match((blind[1] as any).content, /what is this\?\n\n\[Image “shot.png” attached; this model cannot view images.\]/);
});

test('PDFs: anthropic gets a document block; OpenAI-compatible gets the extracted text', () => {
  const msg: ChatMessage[] = [{ role: 'user', blocks: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBERi0=', name: 'review.pdf', text: 'Reviewer 1: the intro is vague.' }, { type: 'text', text: 'summarize' }] }];
  const a = toAnthropicMessages(msg, 'm');
  assert.deepEqual((a[0].content as any[])[0], { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'review.pdf' });
  const o = toOpenAIMessages('s', msg, true);
  assert.match((o[1] as any).content, /summarize\n\n<attached_pdf name="review.pdf">\nReviewer 1: the intro is vague\.\n<\/attached_pdf>/);
});

test('tool images: anthropic puts them in the tool_result; OpenAI-compatible adds a user turn after the tool messages', () => {
  const msgs: ChatMessage[] = [
    { role: 'assistant', blocks: [{ type: 'tool_call', id: 't1', name: 'view_image', input: { path: 'f.png' } }] },
    { role: 'user', blocks: [{ type: 'tool_result', id: 't1', content: 'Viewed f.png', images: [{ mediaType: 'image/png', data: 'AAAA' }] }] },
  ];
  const a = toAnthropicMessages(msgs, 'm');
  assert.deepEqual(((a[1].content as any[])[0].content as any[]).map((c: any) => c.type), ['text', 'image']);
  const o = toOpenAIMessages('s', msgs, true);
  assert.deepEqual(o.map((m) => m.role), ['system', 'assistant', 'tool', 'user']);
  assert.equal((o[3] as any).content[0].type, 'image_url');
});
