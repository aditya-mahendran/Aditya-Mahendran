import { describe, expect, it } from 'vitest';
import { emptyPanelist, type Panelist } from '../src/domain/types.js';
import { PanelService } from '../src/service/PanelService.js';
import { defaultLists } from '../src/store/defaults.js';
import { MemoryStore } from '../src/store/MemoryStore.js';
import { PlanningLayoutStore } from '../src/store/PlanningLayoutStore.js';
import { addedNotes, listedPeople, parseLayout, personToRow, planTabSetup, PlanningTabs, type GridIO } from '../src/store/sheets/PlanningTabs.js';
import { NOW, TEAM, topic, topics } from './helpers.js';

/** The "Where the Money Blows" planning tab as it is in the team's sheet (rows 1–40). */
function moneyTab(): string[][] {
  return [
    ["Note: Once a speaker is confirmed, make a post in the Slack channel and tag someone from ops and from marketing, linking them to a folder with the speaker's bio, headshot, and release form."],
    [],
    ['1', 'Where the Money Blows'],
    ['Director/Owner', 'Ishaan Tibrewal'],
    ['VP Support'],
    ['Description'],
    ['Files', 'Link to panel folder (speaker files and discussion guide)'],
    [],
    ['', 'Name', 'Email (for calendar hold)', "General Notes (e.g. speaker profile you're sourcing for)", 'Bio', 'Headshot'],
    ['Confirmed moderator?'],
    ['Confirmed panelist?'],
    ['Confirmed panelist 2?'],
    ['Confirmed panelist 3?'],
    [],
    ['Potential Moderators'],
    ['#', 'Name', 'Affiliation', 'Reached out?', 'Notes'],
    ['1', 'Matt Roling', 'Abrams Climate Academy, Executive Director', 'No', 'Met at SSI dinner'],
    [], [], [], [], [], [],
    ['Activity', '', '', 'Status', 'Due by'],
    ['Reach out to moderator', '', '', 'In progress', 'Nov 3'],
    ['Reach out to top 5 panelists', '', '', 'Not Started', 'Nov 10'],
  ];
}

/** In-memory grid with the same insert semantics as the Sheets API. */
class FakeGrid implements GridIO {
  writes = 0;
  constructor(public tabs: Record<string, string[][]>) {}
  async sheetTitles() {
    return Object.keys(this.tabs);
  }
  async readGrid(title: string) {
    return this.tabs[title].map((r) => [...r]);
  }
  async writeCells(title: string, cells: { row: number; col: number; value: string }[]) {
    this.writes++;
    const g = this.tabs[title];
    for (const c of cells) {
      while (g.length < c.row) g.push([]);
      const row = g[c.row - 1];
      while (row.length <= c.col) row.push('');
      row[c.col] = c.value;
    }
  }
  async insertRows(title: string, beforeRow: number, count: number) {
    this.tabs[title].splice(beforeRow - 1, 0, ...Array.from({ length: count }, () => [] as string[]));
  }
  rowOf(title: string, a: string) {
    return this.tabs[title].findIndex((r) => r[0] === a) + 1;
  }
  cell(title: string, row: number, col: number) {
    return this.tabs[title][row - 1]?.[col] ?? '';
  }
}

/** Applies setup's plan to a fake grid, as setup-sheet does against the real one. */
async function setUp(grid: FakeGrid, title: string) {
  const plan = planTabSetup(await grid.readGrid(title));
  await grid.writeCells(title, plan.headerCells);
  if (plan.panelists) {
    await grid.insertRows(title, plan.panelists.at, plan.panelists.count);
    await grid.writeCells(title, plan.panelists.values);
  }
  return plan;
}

const person = (o: Partial<Panelist>): Panelist => ({ ...emptyPanelist(), panelA: 'Where the Money Blows', ...o });

describe('tab setup plan', () => {
  it('adds an Outreach Status column and a Potential Panelists list above Activity, and finds the owner', () => {
    const plan = planTabSetup(moneyTab());
    expect(plan.owner).toBe('Ishaan Tibrewal');
    expect(plan.headerCells).toEqual([{ row: 16, col: 5, value: 'Outreach Status' }]);
    expect(plan.panelists).toMatchObject({ at: 24, count: 9 });
    expect(plan.panelists!.values.filter((v) => v.row === 25).map((v) => v.value)).toEqual(['#', 'Name', 'Affiliation', 'Reached out?', 'Notes', 'Outreach Status']);
    expect(plan.panelists!.formatRows[0]).toEqual([15, 24]);
  });

  it('is idempotent once applied', async () => {
    const grid = new FakeGrid({ 'Where the Money Blows': moneyTab() });
    await setUp(grid, 'Where the Money Blows');
    const again = planTabSetup(await grid.readGrid('Where the Money Blows'));
    expect(again.headerCells).toEqual([]);
    expect(again.panelists).toBeUndefined();
    expect(grid.rowOf('Where the Money Blows', 'Activity')).toBe(33);
    expect(grid.cell('Where the Money Blows', 34, 0)).toBe('Reach out to moderator');
  });

  it('parses both lists and the Confirmed slots', async () => {
    const grid = new FakeGrid({ 'Where the Money Blows': moneyTab() });
    await setUp(grid, 'Where the Money Blows');
    const layout = parseLayout(await grid.readGrid('Where the Money Blows'));
    expect(layout.moderators).toMatchObject({ firstRow: 17, endRow: 24, hasNext: true });
    expect(layout.panelists).toMatchObject({ titleRow: 24, headerRow: 25, firstRow: 26, endRow: 33 });
    expect(layout.confirmed.map((c) => [c.row, c.kind])).toEqual([[10, 'moderator'], [11, 'panelist'], [12, 'panelist'], [13, 'panelist']]);
  });
});

describe('planning tab sync', () => {
  async function ready() {
    const grid = new FakeGrid({ 'Where the Money Blows': moneyTab() });
    await setUp(grid, 'Where the Money Blows');
    return { grid, tabs: new PlanningTabs(grid), t: topic('money'), T: 'Where the Money Blows' };
  }

  it('adds a moderator under the existing one, numbered, with affiliation, status and note', async () => {
    const { grid, tabs, t, T } = await ready();
    await tabs.sync(t, null, person({ name: 'Jane Doe', role: 'Partner', company: 'Lowercarbon', speakerType: 'Moderator', status: 'Potential Outreach', notes: '11/10 (Ishaan Tibrewal): Warm intro via Tasha' }));
    expect(grid.tabs[T][17]).toEqual(['2', 'Jane Doe', 'Partner, Lowercarbon', 'No', '11/10 (Ishaan Tibrewal): Warm intro via Tasha', 'Potential Outreach']);
    expect(grid.tabs[T][16][1]).toBe('Matt Roling'); // untouched
  });

  it('puts panelists in the Potential Panelists list', async () => {
    const { grid, tabs, t, T } = await ready();
    await tabs.sync(t, null, person({ name: 'Sam Lee', company: 'Prelude', speakerType: 'Panelist', status: 'Outreach 1 Sent' }));
    expect(grid.tabs[T][25].slice(0, 6)).toEqual(['1', 'Sam Lee', 'Prelude', 'Yes', '', 'Outreach 1 Sent']);
  });

  it('updates status and Reached out?, and adds new notes under what people typed', async () => {
    const { grid, tabs, t, T } = await ready();
    const before = person({ name: 'Matt Roling', speakerType: 'Moderator', status: 'Potential Outreach', notes: '' });
    await tabs.sync(t, before, { ...before, status: 'Interested', notes: '11/10 (Ishaan Tibrewal): Keen, wants to moderate' });
    expect(grid.tabs[T][16]).toEqual(['1', 'Matt Roling', 'Abrams Climate Academy, Executive Director', 'Yes', 'Met at SSI dinner\n11/10 (Ishaan Tibrewal): Keen, wants to moderate', 'Interested']);
  });

  it('fills a Confirmed slot when confirmed and clears it when not', async () => {
    const { grid, tabs, t, T } = await ready();
    const p = person({ name: 'Matt Roling', speakerType: 'Moderator', status: 'Interested' });
    await tabs.sync(t, p, { ...p, status: 'Confirmed', confirmed: 'YES 🥳' });
    expect(grid.cell(T, 10, 1)).toBe('Matt Roling');
    await tabs.sync(t, { ...p, status: 'Confirmed', confirmed: 'YES 🥳' }, { ...p, status: 'Declined', confirmed: '' });
    expect(grid.cell(T, 10, 1)).toBe('');
    const q = person({ name: 'Sam Lee', speakerType: 'Panelist', status: 'Interested' });
    await tabs.sync(t, q, { ...q, status: 'Confirmed' });
    expect(grid.cell(T, 11, 1)).toBe('Sam Lee');
  });

  it('moves someone between lists when their speaker type changes', async () => {
    const { grid, tabs, t, T } = await ready();
    const p = person({ name: 'Matt Roling', speakerType: 'Moderator', status: 'Interested' });
    await tabs.sync(t, p, { ...p, speakerType: 'Panelist' });
    expect(grid.tabs[T][16][1]).toBe('');
    expect(grid.tabs[T][25][1]).toBe('Matt Roling');
  });

  it('inserts a row when a list is full, without overwriting the next section', async () => {
    const { grid, tabs, t, T } = await ready();
    for (let i = 0; i < 8; i++) await tabs.sync(t, null, person({ name: `Mod ${i}`, speakerType: 'Moderator' }));
    const layout = parseLayout(await grid.readGrid(T));
    const names = grid.tabs[T].slice(16, layout.moderators!.endRow - 1).map((r) => r[1]).filter(Boolean);
    expect(names).toEqual(['Matt Roling', ...Array.from({ length: 8 }, (_, i) => `Mod ${i}`)]);
    expect(grid.cell(T, layout.moderators!.endRow, 0)).toBe('Potential Panelists');
    expect(grid.cell(T, layout.moderators!.endRow - 1, 1)).toBe(''); // spacer kept
    expect(grid.tabs[T].find((r) => r[0] === 'Activity')).toBeTruthy();
  });

  it('clears the row when a person is removed (undo of an add)', async () => {
    const { grid, tabs, t, T } = await ready();
    const p = person({ name: 'Jane Doe', speakerType: 'Moderator' });
    await tabs.sync(t, null, p);
    await tabs.sync(t, p, null);
    expect(grid.tabs[T][17].filter(Boolean)).toEqual([]);
  });

  it('extracts only newly added notes', () => {
    expect(addedNotes('a', 'a\nb')).toBe('b');
    expect(addedNotes('a', 'a')).toBe('');
  });
});

describe('planning layout end to end', () => {
  async function setup() {
    const inner = new MemoryStore({ lists: defaultLists(topics), team: structuredClone(TEAM) });
    const grid = new FakeGrid({ 'Where the Money Blows': moneyTab() });
    await setUp(grid, 'Where the Money Blows');
    const store = new PlanningLayoutStore(inner, new PlanningTabs(grid));
    const service = new PanelService(store, topics, { now: () => NOW });
    await service.assign(await service.identify('UADI'), 'UGIA', 'money');
    const gia = await service.identify('UGIA');
    return { inner, grid, service, gia, T: 'Where the Money Blows' };
  }

  it('writes full details to Panel Tracker and the summary to the owner’s tab', async () => {
    const { inner, grid, service, gia, T } = await setup();
    await service.addPanelist(gia, { name: 'Jane Doe', company: 'Lowercarbon', speakerType: 'Moderator', status: 'Interested' });
    expect(inner.tracker.filter((r) => r?.name)).toEqual([expect.objectContaining({ name: 'Jane Doe', panelA: 'Where the Money Blows', lastUpdated: '10/13' })]);
    expect(grid.tabs[T][17].slice(1, 6)).toEqual(['Jane Doe', 'Lowercarbon', 'Yes', '', 'Interested']);
    expect(inner.tabs.size).toBe(0); // no separate copy anywhere
  });

  it('renames without duplicating the Panel Tracker row, and undo clears both places', async () => {
    const { inner, grid, service, gia, T } = await setup();
    const add = await service.addPanelist(gia, { name: 'Jane Doe', speakerType: 'Moderator' });
    const { version } = await service.getPanelist(gia, undefined, 'Jane Doe');
    await service.updatePanelist(gia, { name: 'Jane Doe', version, changes: { name: 'Jane Q. Doe' } });
    expect(inner.tracker.filter((r) => r?.name).map((r) => r!.name)).toEqual(['Jane Q. Doe']);
    expect(grid.tabs[T][17][1]).toBe('Jane Q. Doe');
    const { version: v2 } = await service.getPanelist(gia, undefined, 'Jane Q. Doe');
    const upd = await service.updatePanelist(gia, { name: 'Jane Q. Doe', version: v2, changes: { status: 'Confirmed' } });
    expect(grid.cell(T, 10, 1)).toBe('Jane Q. Doe');
    await service.undoWrite(gia, upd.undoId);
    expect(grid.cell(T, 10, 1)).toBe('');
    expect(add.undoId).toBeTruthy();
  });

  it('lists, status and resync read from Panel Tracker', async () => {
    const { service, gia } = await setup();
    await service.addPanelist(gia, { name: 'A', status: 'Confirmed' });
    await service.addPanelist(gia, { name: 'B' });
    expect((await service.listTopic(gia)).rows.map((r) => r.data.name)).toEqual(['A', 'B']);
    const { topics: ts } = await service.status();
    expect(ts.find((x) => x.topic.id === 'money')?.counts).toMatchObject({ Confirmed: 1, 'Not started': 1 });
    expect(await service.resync()).toEqual({ added: 0, updated: 0, cleared: 0 });
  });

  it('recognises people already listed on the tab once setup has copied them into Panel Tracker', async () => {
    const { inner, grid, service, gia, T } = await setup();
    for (const p of listedPeople(grid.tabs[T])) await inner.addPanelist({ kind: 'tracker' }, personToRow(p, 'Where the Money Blows', '11/01'));
    expect(inner.tracker[0]).toMatchObject({ name: 'Matt Roling', company: 'Abrams Climate Academy, Executive Director', status: 'Potential Outreach', speakerType: 'Moderator', notes: 'Met at SSI dinner' });
    const { version } = await service.getPanelist(gia, undefined, 'matt roling');
    await service.updatePanelist(gia, { name: 'Matt Roling', version, changes: { status: 'Interested' }, note: 'Keen to moderate' });
    expect(grid.tabs[T][16]).toEqual(['1', 'Matt Roling', 'Abrams Climate Academy, Executive Director', 'Yes', 'Met at SSI dinner\n10/13 (Gia Levatich): Keen to moderate', 'Interested']);
    expect(grid.tabs[T].filter((r) => r[1] === 'Matt Roling')).toHaveLength(1);
  });
});
