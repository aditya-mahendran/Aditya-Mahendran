import { normalizeName, sameName, sameValue } from '../../domain/normalize.js';
import { isConfirmed } from '../../domain/rules.js';
import { emptyPanelist, type Panelist, type Topic } from '../../domain/types.js';
import { logger } from '../../logger.js';

/** The few spreadsheet operations the planning-tab sync needs. Rows are 1-based, columns 0-based. */
export interface GridIO {
  sheetTitles(): Promise<string[]>;
  /** The tab's values from A1, as displayed; rows may be ragged. */
  readGrid(title: string): Promise<string[][]>;
  writeCells(title: string, cells: { row: number; col: number; value: string }[]): Promise<void>;
  /** Inserts `count` blank rows so the first new row is `beforeRow`, copying formatting from the row above. */
  insertRows(title: string, beforeRow: number, count: number): Promise<void>;
}

export const SECTION = {
  moderators: 'Potential Moderators',
  panelists: 'Potential Panelists',
  activity: 'Activity',
} as const;

export const LIST_HEADERS = ['#', 'Name', 'Affiliation', 'Reached out?', 'Notes', 'Outreach Status'] as const;

export interface ListArea {
  kind: 'moderator' | 'panelist';
  titleRow: number;
  headerRow: number;
  /** First row that can hold a person (the row after the header). */
  firstRow: number;
  /** Row of the next section's title, or one past the end of the tab when this is the last section. */
  endRow: number;
  /** Whether another section follows (then one blank spacer row is kept above it). */
  hasNext: boolean;
  cols: { num: number; name: number; affiliation: number; reached: number; notes: number; status: number };
}

export interface PlanningLayout {
  moderators?: ListArea;
  panelists?: ListArea;
  confirmed: { row: number; kind: 'moderator' | 'panelist' }[];
  /** Column of the Name cell in the Confirmed block. */
  confirmedNameCol: number;
}

const cell = (grid: string[][], row: number, col: number) => String(grid[row - 1]?.[col] ?? '').trim();
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]/g, '');

function findRow(grid: string[][], text: string, from = 1): number {
  for (let r = from; r <= grid.length; r++) if (squash(cell(grid, r, 0)) === squash(text)) return r;
  return -1;
}

function listArea(grid: string[][], kind: ListArea['kind'], title: string): ListArea | undefined {
  const titleRow = findRow(grid, title);
  if (titleRow < 0) return undefined;
  const headerRow = titleRow + 1;
  const header = (grid[headerRow - 1] ?? []).map((h) => squash(String(h)));
  const col = (label: string) => header.indexOf(squash(label));
  const cols = {
    num: col('#'),
    name: col('Name'),
    affiliation: col('Affiliation'),
    reached: col('Reached out?'),
    notes: col('Notes'),
    status: col('Outreach Status'),
  };
  if (cols.name < 0) return undefined;
  // The list runs until the next section title (any later non-blank A cell that isn't a number).
  let endRow = grid.length + 1;
  for (let r = headerRow + 1; r <= grid.length; r++) {
    const a = cell(grid, r, 0);
    if (a && !/^\d+$/.test(a)) {
      endRow = r;
      break;
    }
  }
  return { kind, titleRow, headerRow, firstRow: headerRow + 1, endRow, hasNext: endRow <= grid.length, cols };
}

/** Reads where the lists and Confirmed slots are on a planning tab. Tolerates rows moving around. */
export function parseLayout(grid: string[][]): PlanningLayout {
  const confirmed: PlanningLayout['confirmed'] = [];
  let confirmedNameCol = 1;
  for (let r = 1; r <= grid.length; r++) {
    const a = cell(grid, r, 0).toLowerCase();
    const m = a.match(/^confirmed (moderator|panelist)/);
    if (m) confirmed.push({ row: r, kind: m[1] as 'moderator' | 'panelist' });
  }
  if (confirmed.length) {
    const header = (grid[confirmed[0].row - 2] ?? []).map((h) => squash(String(h)));
    const i = header.indexOf('name');
    if (i >= 0) confirmedNameCol = i;
  }
  return {
    moderators: listArea(grid, 'moderator', SECTION.moderators),
    panelists: listArea(grid, 'panelist', SECTION.panelists),
    confirmed,
    confirmedNameCol,
  };
}

export function affiliation(p: Pick<Panelist, 'role' | 'company'>): string {
  return [p.role, p.company].map((s) => s.trim()).filter(Boolean).join(', ');
}

export function reachedOut(status: string): string {
  return ['', 'potential outreach'].includes(status.trim().toLowerCase()) ? 'No' : 'Yes';
}

/** The text added to a notes cell between two versions (notes are append-only). */
export function addedNotes(before: string, after: string): string {
  if (sameValue(before, after)) return '';
  return (after.startsWith(before) ? after.slice(before.length) : after).trim();
}

/**
 * Keeps an owner's planning tab in step with Panel Tracker: one row per speaker in the
 * Potential Moderators / Potential Panelists list, and the Confirmed slots. Only these
 * cells are written; the rest of the tab (checklist, links, speaker logistics) is left alone.
 * People's own notes are never overwritten — new notes are added underneath.
 */
export class PlanningTabs {
  constructor(private readonly io: GridIO) {}

  async sync(topic: Topic, before: Panelist | null, after: Panelist | null): Promise<void> {
    if (!(await this.io.sheetTitles()).includes(topic.tabName)) {
      logger.warn('planning.no_tab', { tab: topic.tabName });
      return;
    }
    const title = topic.tabName;
    let grid = await this.io.readGrid(title);
    let layout = parseLayout(grid);
    const oldName = (before ?? after)!.name;
    let found = this.locate(grid, layout, oldName);
    const writes: { row: number; col: number; value: string }[] = [];

    const clearListRow = (area: ListArea, row: number) => {
      for (const c of Object.values(area.cols)) if (c >= 0) writes.push({ row, col: c, value: '' });
    };

    if (!after) {
      if (found) clearListRow(found.area, found.row);
      this.syncConfirmed(grid, layout, oldName, null, writes);
      if (writes.length) await this.io.writeCells(title, writes);
      return;
    }

    const wanted = this.targetList(layout, after, found?.area);
    if (!wanted) {
      logger.warn('planning.no_list', { tab: title });
      return;
    }
    if (found && found.area.kind !== wanted.kind) {
      clearListRow(found.area, found.row);
      await this.io.writeCells(title, writes.splice(0));
      found = undefined;
    }

    let row = found?.row;
    let area = wanted;
    if (!row) {
      row = this.freeSlot(grid, wanted);
      if (!row) {
        const { at, count } = this.insertAt(grid, wanted);
        await this.io.insertRows(title, at, count);
        grid = await this.io.readGrid(title);
        layout = parseLayout(grid);
        area = (wanted.kind === 'moderator' ? layout.moderators : layout.panelists)!;
        row = this.freeSlot(grid, area);
        if (!row) throw new Error(`No room in the ${area.kind} list on "${title}"`);
      }
    }
    const { cols } = area;
    const existing = (c: number) => (c >= 0 ? cell(grid, row!, c) : '');
    const put = (c: number, value: string) => {
      if (c >= 0 && existing(c) !== value) writes.push({ row: row!, col: c, value });
    };

    put(cols.name, after.name);
    if (cols.num >= 0 && !existing(cols.num)) put(cols.num, String(this.nextNumber(grid, area)));
    // Affiliation is ours to fill when blank, or to update if it still shows what we wrote last time.
    const aff = affiliation(after);
    if (aff && (!existing(cols.affiliation) || (before && existing(cols.affiliation) === affiliation(before)))) put(cols.affiliation, aff);
    put(cols.reached, reachedOut(after.status));
    put(cols.status, after.status);
    const added = addedNotes(before?.notes ?? '', after.notes);
    if (added && cols.notes >= 0) {
      const current = existing(cols.notes);
      writes.push({ row, col: cols.notes, value: current ? `${current}\n${added}` : added });
    }

    this.syncConfirmed(grid, layout, oldName, after, writes);
    if (writes.length) await this.io.writeCells(title, writes);
  }

  /** Finds the person's row in either list by name. */
  locate(grid: string[][], layout: PlanningLayout, name: string): { area: ListArea; row: number } | undefined {
    for (const area of [layout.moderators, layout.panelists]) {
      if (!area) continue;
      for (let r = area.firstRow; r < area.endRow; r++) {
        if (cell(grid, r, area.cols.name) && sameName(cell(grid, r, area.cols.name), name)) return { area, row: r };
      }
    }
    return undefined;
  }

  private targetList(layout: PlanningLayout, p: Panelist, current?: ListArea): ListArea | undefined {
    const type = p.speakerType.trim().toLowerCase();
    if (type === 'moderator') return layout.moderators ?? layout.panelists;
    if (type === 'panelist') return layout.panelists ?? layout.moderators;
    return current ?? layout.panelists ?? layout.moderators;
  }

  /** First empty person row, keeping one blank spacer above the next section. Undefined when the list is full. */
  private freeSlot(grid: string[][], area: ListArea): number | undefined {
    const last = area.hasNext ? area.endRow - 2 : Number.MAX_SAFE_INTEGER;
    for (let r = area.firstRow; r <= last; r++) {
      const used = Object.values(area.cols).some((c) => c >= 0 && c !== area.cols.num && cell(grid, r, c));
      if (!used) return r;
    }
    return undefined;
  }

  /** Where to insert when the list is full: above the spacer (1 row), or before the next section plus a new spacer (2 rows). */
  private insertAt(grid: string[][], area: ListArea): { at: number; count: number } {
    const spacer = area.endRow - 1;
    const blank = spacer > area.headerRow && !(grid[spacer - 1] ?? []).some((v) => String(v ?? '').trim());
    return blank ? { at: spacer, count: 1 } : { at: area.endRow, count: 2 };
  }

  private nextNumber(grid: string[][], area: ListArea): number {
    let max = 0;
    for (let r = area.firstRow; r < area.endRow; r++) max = Math.max(max, Number(cell(grid, r, area.cols.num)) || 0);
    return max + 1;
  }

  /** Puts a confirmed speaker's name in a free Confirmed slot of the right kind; clears it when no longer confirmed. */
  private syncConfirmed(grid: string[][], layout: PlanningLayout, oldName: string, after: Panelist | null, writes: { row: number; col: number; value: string }[]) {
    const col = layout.confirmedNameCol;
    const holding = layout.confirmed.filter((s) => {
      const v = cell(grid, s.row, col);
      return v && (sameName(v, oldName) || (after && sameName(v, after.name)));
    });
    const confirmed = after && isConfirmed(after);
    if (!confirmed) {
      for (const s of holding) writes.push({ row: s.row, col, value: '' });
      return;
    }
    if (holding.length) {
      for (const s of holding) if (cell(grid, s.row, col) !== after.name) writes.push({ row: s.row, col, value: after.name });
      return;
    }
    const kind = after.speakerType.trim().toLowerCase() === 'moderator' ? 'moderator' : 'panelist';
    const slot = layout.confirmed.find((s) => s.kind === kind && !cell(grid, s.row, col));
    if (slot) writes.push({ row: slot.row, col, value: after.name });
    else logger.warn('planning.confirmed_full', { kind, name: normalizeName(after.name) });
  }
}

export const PANELIST_SLOTS = 6;

/** What setup must do to one planning tab so Peter Panel can keep it up to date. Pure; used by setup-sheet. */
export interface TabSetupPlan {
  /** Header cells to add (e.g. "Outreach Status"), 1-based row / 0-based col. */
  headerCells: { row: number; col: number; value: string }[];
  /** Insert a Potential Panelists section: rows to insert before `at`, then values to write and formats to copy. */
  panelists?: {
    at: number;
    count: number;
    values: { row: number; col: number; value: string }[];
    /** Copy row formatting: [source row, destination row] (1-based, after insertion). */
    formatRows: [number, number][];
  };
  /** Owner named in the tab's Director/Owner cell, if any. */
  owner?: string;
  problems: string[];
}

export function planTabSetup(grid: string[][]): TabSetupPlan {
  const plan: TabSetupPlan = { headerCells: [], problems: [] };
  const ownerRow = findRow(grid, 'Director/Owner');
  if (ownerRow > 0) plan.owner = cell(grid, ownerRow, 1) || undefined;
  const layout = parseLayout(grid);
  const mods = layout.moderators;
  if (!mods) {
    plan.problems.push(`no "${SECTION.moderators}" section with a Name column`);
    return plan;
  }
  const modHeader = (grid[mods.headerRow - 1] ?? []).map((v) => String(v ?? '').trim());
  if (mods.cols.status < 0) {
    const col = Math.max(...Object.values(mods.cols)) + 1;
    plan.headerCells.push({ row: mods.headerRow, col, value: 'Outreach Status' });
    modHeader[col] = 'Outreach Status';
  }
  if (!layout.panelists) {
    // New section goes where the next section (e.g. Activity) starts now; that section moves down.
    const at = mods.endRow;
    const count = 2 + PANELIST_SLOTS + 1; // title, header, slots, spacer
    const values: TabSetupPlan['headerCells'] = [{ row: at, col: 0, value: SECTION.panelists }];
    modHeader.forEach((h, col) => h && values.push({ row: at + 1, col, value: h }));
    const shift = (r: number) => (r >= at ? r + count : r);
    const formatRows: [number, number][] = [
      [shift(mods.titleRow), at],
      [shift(mods.headerRow), at + 1],
      ...Array.from({ length: PANELIST_SLOTS }, (_, i) => [shift(mods.firstRow), at + 2 + i] as [number, number]),
    ];
    plan.panelists = { at, count, values, formatRows };
  }
  return plan;
}

export interface ListedPerson {
  name: string;
  affiliation: string;
  reachedOut: string;
  notes: string;
  status: string;
  kind: 'moderator' | 'panelist';
}

/** People already typed into a planning tab's lists (used once by setup to seed Panel Tracker). */
export function listedPeople(grid: string[][]): ListedPerson[] {
  const layout = parseLayout(grid);
  const out: ListedPerson[] = [];
  for (const area of [layout.moderators, layout.panelists]) {
    if (!area) continue;
    for (let r = area.firstRow; r < area.endRow; r++) {
      const name = cell(grid, r, area.cols.name);
      if (!name) continue;
      const get = (c: number) => (c >= 0 ? cell(grid, r, c) : '');
      out.push({
        name,
        affiliation: get(area.cols.affiliation),
        reachedOut: get(area.cols.reached),
        notes: get(area.cols.notes),
        status: get(area.cols.status),
        kind: area.kind,
      });
    }
  }
  return out;
}

/** The Panel Tracker row for someone already listed on a planning tab. */
export function personToRow(p: ListedPerson, panel: string, today: string): Panelist {
  const status = p.status || (/^y/i.test(p.reachedOut) ? 'Outreach 1 Sent' : 'Potential Outreach');
  return {
    ...emptyPanelist(),
    name: p.name,
    company: p.affiliation,
    status,
    speakerType: p.kind === 'moderator' ? 'Moderator' : 'Panelist',
    panelA: panel,
    notes: p.notes,
    lastUpdated: today,
  };
}
