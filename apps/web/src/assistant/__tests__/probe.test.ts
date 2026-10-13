import { afterEach, describe, expect, it, vi } from 'vitest';
import { gateway } from '../api';

const respond = (body: string, type: string, status = 200) => vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } }));

describe('gateway.probe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is null when Aldine answers with its app page (no gateway deployed)', async () => {
    vi.stubGlobal('fetch', respond('<!doctype html><html></html>', 'text/html'));
    expect(await gateway.probe()).toBeNull();
  });

  it('is null on errors and on JSON that is not a gateway config', async () => {
    vi.stubGlobal('fetch', respond('{"error":"nope"}', 'application/json', 502));
    expect(await gateway.probe()).toBeNull();
    vi.stubGlobal('fetch', respond('{"ok":true}', 'application/json'));
    expect(await gateway.probe()).toBeNull();
  });

  it('returns the config from a gateway', async () => {
    const cfg = { agentLabel: 'Paper Assistant', user: { id: 'u', name: 'Ada' }, authEnabled: true, models: [], defaultModel: 'mock:scripted', limits: { maxMessageChars: 1 } };
    vi.stubGlobal('fetch', respond(JSON.stringify(cfg), 'application/json'));
    expect(await gateway.probe()).toMatchObject({ agentLabel: 'Paper Assistant' });
  });
});
