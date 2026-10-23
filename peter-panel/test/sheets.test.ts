import { describe, expect, it, vi } from 'vitest';
import { emptyPanelist } from '../src/domain/types.js';
import { parseSheetId } from '../src/store/sheets/googleAuth.js';
import { a1, SheetsStore } from '../src/store/sheets/SheetsStore.js';
import { createStore } from '../src/store/createStore.js';
import { topic, topics } from './helpers.js';

const HEADER = ['Priority', 'Last Updated on (MM/DD)', 'Outreach Status', 'Participation Confirmed', 'Name', 'Role/Title', 'Company', 'Kellogg Alum?', 'Speaker Description', 'Speaker Type', 'For which panel (option A)?', 'For any other panel (option B)?', 'Notes', 'Location', 'Connection'];

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

/** A small fake of the Sheets API: one tracker with one row, plus Team and Update Log. */
function fakeSheets(opts: { trackerRows?: string[][]; status?: number } = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const tabs = [
    { sheetId: 1, title: 'Panel Tracker', gridProperties: { rowCount: 300, columnCount: 15 } },
    { sheetId: 2, title: 'Update Log', gridProperties: { rowCount: 3 } },
    { sheetId: 3, title: 'Team', gridProperties: { rowCount: 20 } },
  ];
  const trackerRows = opts.trackerRows ?? [
    ['', '10/01', 'Outreach 1 Sent', '', 'Joe J'],
    [],
  ];
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    const path = decodeURIComponent(url.replace('https://sheets.googleapis.com/v4/spreadsheets/SHEET', ''));
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, body });
    if (opts.status) return response(opts.status, { error: { code: opts.status, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } });
    if (path.startsWith('?fields=sheets.properties')) return response(200, { sheets: tabs.map((properties) => ({ properties })) });
    if (path.startsWith("/values/'Panel Tracker'!A2:O")) return response(200, { values: trackerRows });
    if (path.startsWith("/values/'Team'!A1:D")) return response(200, { values: [['Slack User ID', 'Name', 'Role', 'Topic'], ['U1', 'Adi Mahendran', 'admin'], ['', 'Gia Levatich', 'owner', 'Air Time']] });
    if (path.startsWith("/values/'Update Log'!1:1")) return response(200, { values: [['Timestamp (CDT)', 'Submitted By', 'Panelist Name', 'Update', 'Outreach Status']] });
    if (path.startsWith("/values/'Lists'!A1:A15")) return response(200, { values: topics.map((t) => [t.panel]) });
    if (path.includes('dataValidation')) {
      const cells: any[] = Array(15).fill({});
      cells[2] = { dataValidation: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Potential Outreach' }, { userEnteredValue: 'Confirmed' }] } } };
      cells[10] = { dataValidation: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: "='Lists'!$A$1:$A$15" }] } } };
      return response(200, { sheets: [{ data: [{ rowData: [{ values: cells }] }] }] });
    }
    if (path.includes('columnMetadata')) return response(200, { sheets: [{ data: [{ columnMetadata: [{ pixelSize: 80 }, { pixelSize: 120 }] }] }] });
    if (path === ':batchUpdate' && body.requests[0]?.addSheet) return response(200, { replies: [{ addSheet: { properties: { sheetId: 99, title: body.requests[0].addSheet.properties.title } } }] });
    return response(200, {});
  });
  const store = new SheetsStore(SheetsStore.client({ getToken: async () => 't' }, { fetch: fetch as never }), 'SHEET', topics);
  return { store, calls };
}

describe('Google Sheets store', () => {
  it('accepts a sheet URL or bare ID', () => {
    expect(parseSheetId('https://docs.google.com/spreadsheets/d/1AbC-d_9/edit#gid=0')).toBe('1AbC-d_9');
    expect(parseSheetId(' 1AbC-d_9 ')).toBe('1AbC-d_9');
    expect(a1("Bob's Tab", 'A1')).toBe("'Bob''s Tab'!A1");
  });

  it('reads rows by position and skips blanks', async () => {
    const { store } = fakeSheets();
    const rows = await store.listPanelists({ kind: 'tracker' });
    expect(rows).toEqual([{ rowIndex: 0, data: expect.objectContaining({ name: 'Joe J', status: 'Outreach 1 Sent', lastUpdated: '10/01' }) }]);
  });

  it('writes only changed cells, grouped into ranges', async () => {
    const { store, calls } = fakeSheets();
    await store.updatePanelist({ kind: 'tracker' }, 0, { status: 'Interested', confirmed: '', notes: '=evil()' });
    const write = calls.find((c) => c.path === '/values:batchUpdate')!;
    expect(write.body).toEqual({
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: "'Panel Tracker'!C2:D2", values: [['Interested', '']] },
        { range: "'Panel Tracker'!M2:M2", values: [["'=evil()"]] },
      ],
    });
  });

  it('fills the first blank row before appending', async () => {
    const { store, calls } = fakeSheets();
    const r = await store.addPanelist({ kind: 'tracker' }, { ...emptyPanelist(), name: 'Ann B' });
    expect(r.rowIndex).toBe(1);
    expect(calls.find((c) => c.path === '/values:batchUpdate')!.body.data[0].range).toBe("'Panel Tracker'!A3:O3");
  });

  it('grows the grid when the tab is full', async () => {
    const full = Array.from({ length: 300 }, (_, i) => ['', '', '', '', `P${i}`]);
    const { store, calls } = fakeSheets({ trackerRows: full });
    await store.addPanelist({ kind: 'tracker' }, { ...emptyPanelist(), name: 'Ann B' });
    expect(calls.find((c) => c.body?.requests?.[0]?.appendDimension)).toBeTruthy();
    expect(calls.find((c) => c.path === '/values:batchUpdate')!.body.data[0].range).toBe("'Panel Tracker'!A302:O302");
  });

  it('creates a green topic tab with the tracker header, dropdowns and widths', async () => {
    const { store, calls } = fakeSheets();
    expect(await store.hasTopicTab(topic('airtime'))).toBe(false);
    await store.createTopicTab(topic('airtime'));
    const batches = calls.filter((c) => c.path === ':batchUpdate').map((c) => c.body.requests);
    expect(batches[0][0].addSheet.properties).toMatchObject({ title: 'Air Time', tabColorStyle: { rgbColor: { red: 0 } }, gridProperties: { frozenRowCount: 1 } });
    const second = batches[1];
    expect(second[0].copyPaste).toMatchObject({ pasteType: 'PASTE_FORMAT', destination: { sheetId: 99 } });
    expect(second[1].copyPaste).toMatchObject({ pasteType: 'PASTE_VALUES', source: { endRowIndex: 1 } });
    expect(second.filter((r: any) => r.updateDimensionProperties)).toHaveLength(2);
  });

  it('reads dropdowns from data validation, following range references', async () => {
    const { store } = fakeSheets();
    const lists = await store.readLists();
    expect(lists.status).toEqual(['Potential Outreach', 'Confirmed']);
    expect(lists.panelA).toHaveLength(15);
    expect(lists.priority).toEqual(['High', 'Medium', 'Low']); // fallback when no validation
  });

  it('reads Team and writes back by Slack ID or name', async () => {
    const { store, calls } = fakeSheets();
    expect(await store.readTeam()).toEqual([
      { slackId: 'U1', name: 'Adi Mahendran', role: 'admin', topic: '' },
      { slackId: '', name: 'Gia Levatich', role: 'owner', topic: 'Air Time' },
    ]);
    await store.writeTeamMember({ slackId: 'UGIA', name: 'gia levatich', role: 'owner', topic: 'Air Time' });
    expect(calls.find((c) => c.path === '/values:batchUpdate')!.body.data[0].range).toBe("'Team'!A3:D3");
  });

  it('appends Update Log rows under the existing headers', async () => {
    const { store, calls } = fakeSheets();
    await store.appendLog({ timestamp: '10/20/2026 10:00 CDT', submittedBy: 'Adi', panelistName: 'Joe J', update: 'Status: A → B', fields: { status: 'Interested' } });
    const append = calls.find((c) => c.path.includes(':append'))!;
    expect(append.path).toContain('insertDataOption=INSERT_ROWS');
    expect(append.body.values).toEqual([['10/20/2026 10:00 CDT', 'Adi', 'Joe J', 'Status: A → B', 'Interested']]);
  });

  it('explains how to fix a sharing problem', async () => {
    const { store } = fakeSheets({ status: 403 });
    await expect(store.verifyAccess('bot@proj.iam.gserviceaccount.com')).rejects.toThrow(/Share it with bot@proj\.iam\.gserviceaccount\.com as an Editor/);
  });

  it('runs the startup access check once through createStore (no self-recursion)', async () => {
    const verify = vi.spyOn(SheetsStore.prototype, 'verifyAccess').mockResolvedValue(undefined);
    const store = createStore(
      {
        store: 'sheets',
        slack: { botToken: 'x', port: 0 },
        remindersEnabled: false,
        google: { sheetId: 'SHEET', keyJson: JSON.stringify({ client_email: 'bot@proj.iam.gserviceaccount.com', private_key: 'unused' }) },
      },
      topics,
    );
    await store.check!();
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith('bot@proj.iam.gserviceaccount.com');
    verify.mockRestore();
  });
});
