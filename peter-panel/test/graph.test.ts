import { describe, expect, it, vi } from 'vitest';
import { emptyPanelist } from '../src/domain/types.js';
import { GraphClient, GraphError } from '../src/store/graph/GraphClient.js';
import { GraphStore, cellValue, columnLetter, contiguousRuns, headerToField, parseAddress } from '../src/store/graph/GraphStore.js';
import { topics } from './helpers.js';

describe('helpers', () => {
  it('parses table addresses', () => {
    expect(parseAddress("'Where the Money Blows'!A1:O101")).toEqual({ sheet: 'Where the Money Blows', startRow: 1, endRow: 101, startCol: 'A' });
    expect(parseAddress("'Bob''s Tab'!$B$3")).toEqual({ sheet: "Bob's Tab", startRow: 3, endRow: 3, startCol: 'B' });
  });

  it('groups changed columns into contiguous ranges', () => {
    expect(contiguousRuns(['notes', 'status', 'lastUpdated', 'confirmed'])).toEqual([['lastUpdated', 'status', 'confirmed'], ['notes']]);
  });

  it('neutralises formulas in user text but keeps legit values', () => {
    expect(cellValue('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(cellValue('@everyone')).toBe(`'@everyone`);
    expect(cellValue('--')).toBe('--');
    expect(cellValue('-5')).toBe('-5');
    expect(cellValue('Joe')).toBe('Joe');
  });

  it('maps reference / log headers to fields', () => {
    expect(headerToField('Outreach Status')).toBe('status');
    expect(headerToField('For which panel (option A)?')).toBe('panelA');
    expect(headerToField('Kellogg Alum?')).toBe('alum');
    expect(headerToField('Last Updated on (MM/DD)')).toBe('lastUpdated');
    expect(headerToField('Connection')).toBe('connection');
    expect(headerToField('Random')).toBeUndefined();
  });

  it('builds column letters', () => {
    expect([1, 15, 26, 27].map(columnLetter)).toEqual(['A', 'O', 'Z', 'AA']);
  });
});

function response(status: number, body: unknown = {}, headers: Record<string, string> = {}) {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
}

describe('GraphClient retry', () => {
  const tokens = { getToken: async () => 'tok' };

  it('retries 429/503/504 honouring Retry-After, then succeeds', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(429, {}, { 'retry-after': '7' }))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200, { ok: true }));
    const sleep = vi.fn(async () => {});
    const g = new GraphClient(tokens, { fetch, sleep, baseUrl: '' });
    expect(await g.request('GET', '/x')).toEqual({ ok: true });
    expect(sleep.mock.calls).toEqual([[7000], [2000]]);
  });

  it('gives up after 3 tries and surfaces the error', async () => {
    const fetch = vi.fn().mockResolvedValue(response(504, { error: { code: 'gatewayTimeout', message: 'slow' } }));
    const g = new GraphClient(tokens, { fetch, sleep: async () => {}, baseUrl: '' });
    await expect(g.request('GET', '/x')).rejects.toBeInstanceOf(GraphError);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry other errors', async () => {
    const fetch = vi.fn().mockResolvedValue(response(400, { error: { code: 'InvalidArgument', message: 'bad' } }));
    const g = new GraphClient(tokens, { fetch, sleep: async () => {}, baseUrl: '' });
    await expect(g.request('GET', '/x')).rejects.toThrow('Microsoft Graph: bad');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

/** A tiny fake of the Graph workbook endpoints the store uses for rows. */
function fakeWorkbook() {
  const calls: { method: string; path: string; body?: any }[] = [];
  const header = ['Priority', 'Last Updated on (MM/DD)', 'Outreach Status', 'Participation Confirmed', 'Name', 'Role/Title', 'Company', 'Kellogg Alum?', 'Speaker Description', 'Speaker Type', 'For which panel (option A)?', 'For any other panel (option B)?', 'Notes', 'Location', 'Connection'];
  const blank = Array(15).fill('');
  const joe = [...blank];
  joe[4] = 'Joe J';
  joe[2] = 'Outreach 1 Sent';
  const table = { address: "'Panel Tracker'!A1:O4", text: [header, joe, [...blank], [...blank]] };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = decodeURIComponent(url.replace(/^.*\/workbook/, ''));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, body });
    if (path === '/createSession') return response(201, { id: 'sess' });
    if (path.startsWith('/tables/tbl_PanelTracker/range')) return response(200, table);
    return response(200, {});
  });
  const store = new GraphStore(new GraphClient({ getToken: async () => 't' }, { fetch: fetch as never, baseUrl: '' }), '/wb/workbook', topics);
  return { store, calls, fetch };
}

describe('GraphStore', () => {
  it('reads rows by position and skips blank ones', async () => {
    const { store } = fakeWorkbook();
    const rows = await store.listPanelists({ kind: 'tracker' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rowIndex: 0, data: { name: 'Joe J', status: 'Outreach 1 Sent' } });
    await store.close();
  });

  it('writes only the changed cells, grouped into ranges, inside a workbook session', async () => {
    const { store, calls, fetch } = fakeWorkbook();
    await store.updatePanelist({ kind: 'tracker' }, 0, { status: 'Interested', confirmed: '', notes: 'n' });
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((p) => p.path)).toEqual([
      "/worksheets/Panel Tracker/range(address='C2:D2')",
      "/worksheets/Panel Tracker/range(address='M2:M2')",
    ]);
    expect(patches[0].body).toEqual({ values: [['Interested', '']] });
    const headers = (fetch.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>;
    expect(headers['workbook-session-id']).toBe('sess');
    await store.close();
  });

  it('fills the first fully blank table row before appending', async () => {
    const { store, calls } = fakeWorkbook();
    const r = await store.addPanelist({ kind: 'tracker' }, { ...emptyPanelist(), name: 'Ann B' });
    expect(r.rowIndex).toBe(1);
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe("/worksheets/Panel Tracker/range(address='A3:O3')");
    expect(patch.body.values[0][4]).toBe('Ann B');
    expect(calls.some((c) => c.path.includes('/rows/add'))).toBe(false);
    await store.close();
  });
});
