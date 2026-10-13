import { normalizeName } from '../../domain/normalize.js';
import {
  COLUMNS,
  COLUMN_BY_KEY,
  DROPDOWN_FIELDS,
  emptyPanelist,
  FIELD_LABELS,
  FIELDS,
  type DropdownLists,
  type FieldKey,
  type LogEntry,
  type Panelist,
  type PanelistRow,
  type ReferenceRow,
  type SheetRef,
  type TeamMember,
  type Topic,
} from '../../domain/types.js';
import { logger } from '../../logger.js';
import { defaultLists } from '../defaults.js';
import type { TrackerStore } from '../TrackerStore.js';
import { GraphClient, WorkbookSession } from './GraphClient.js';

export const SHEETS = {
  tracker: 'Panel Tracker',
  trackerTable: 'tbl_PanelTracker',
  log: 'Update Log',
  team: 'Team',
  reference: 'Last Years Panelists (Reference',
  lists: 'Lists',
} as const;

/** Data rows pre-created (with dropdowns) on a new topic tab. More are appended as needed. */
export const TOPIC_TAB_ROWS = 100;
export const TOPIC_TAB_COLOR = '#00B050';
const CACHE_MS = 60_000;
const TEAM_HEADERS = ['Slack User ID', 'Name', 'Role', 'Topic'];

interface RangeText {
  address: string;
  text: string[][];
}

/** Parses "'Panel Tracker'!A1:O300" into sheet name and first/last row. */
export function parseAddress(address: string): { sheet: string; startRow: number; endRow: number; startCol: string } {
  const bang = address.lastIndexOf('!');
  const sheet = address.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'");
  const m = address.slice(bang + 1).match(/^\$?([A-Z]+)\$?(\d+)(?::\$?[A-Z]+\$?(\d+))?$/);
  if (!m) throw new Error(`Unexpected range address: ${address}`);
  return { sheet, startCol: m[1], startRow: Number(m[2]), endRow: Number(m[3] ?? m[2]) };
}

/** Groups field keys into contiguous column runs, e.g. [C,D,M] → [[C,D],[M]]. */
export function contiguousRuns(fields: FieldKey[]): FieldKey[][] {
  const sorted = [...new Set(fields)].sort((a, b) => FIELDS.indexOf(a) - FIELDS.indexOf(b));
  const runs: FieldKey[][] = [];
  for (const f of sorted) {
    const last = runs.at(-1);
    if (last && FIELDS.indexOf(f) === FIELDS.indexOf(last.at(-1)!) + 1) last.push(f);
    else runs.push([f]);
  }
  return runs;
}

/** Stops user text being read as a formula when written through the values API. */
export function cellValue(v: string): string {
  return /^[=+\-@]/.test(v) && !/^--$/.test(v) && !/^-?\d/.test(v) ? `'${v}` : v;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Maps a header cell (from the reference tab or Update Log) to a tracker field. */
export function headerToField(header: string): FieldKey | undefined {
  const h = squash(header);
  if (!h) return undefined;
  for (const c of COLUMNS) if (squash(c.header) === h || squash(FIELD_LABELS[c.key]) === h) return c.key;
  if (h.startsWith('lastupdated')) return 'lastUpdated';
  if (h.includes('outreachstatus') || h === 'status') return 'status';
  if (h.startsWith('participation')) return 'confirmed';
  if (h.startsWith('kelloggalum')) return 'alum';
  if (h.startsWith('forwhichpanel')) return 'panelA';
  if (h.startsWith('foranyotherpanel')) return 'panelB';
  if (h.startsWith('roletitle') || h === 'title' || h === 'role') return 'role';
  return undefined;
}

function rowToPanelist(cells: string[]): Panelist {
  const p = emptyPanelist();
  FIELDS.forEach((f, i) => (p[f] = String(cells[i] ?? '')));
  return p;
}

const sheetPath = (name: string) => `/worksheets/${encodeURIComponent(name)}`;
const rangePath = (sheet: string, address: string) => `${sheetPath(sheet)}/range(address='${encodeURIComponent(address)}')`;

/** TrackerStore backed by the SharePoint workbook through the Microsoft Graph Excel API. */
export class GraphStore implements TrackerStore {
  private readonly wb: WorkbookSession;
  private tableCache = new Map<string, { at: number; value: RangeText }>();
  private sheetNames: { at: number; names: Set<string> } | null = null;
  private referenceCache: { at: number; rows: ReferenceRow[] } | null = null;
  private logHeaders: string[] | null = null;

  constructor(
    graph: GraphClient,
    workbookPath: string,
    private readonly topics: Topic[],
    private readonly now: () => number = Date.now,
  ) {
    this.wb = new WorkbookSession(graph, workbookPath);
  }

  static workbookPath(siteId: string, driveId: string, itemId: string) {
    return `/sites/${siteId}/drives/${driveId}/items/${itemId}/workbook`;
  }

  close() {
    return this.wb.close();
  }

  // ---------------------------------------------------------------- tables

  private tableFor(sheet: SheetRef) {
    return sheet.kind === 'tracker' ? SHEETS.trackerTable : sheet.topic.tableName;
  }

  private async readTable(table: string): Promise<RangeText> {
    const hit = this.tableCache.get(table);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.value;
    const value = await this.wb.request<RangeText>('GET', `/tables/${encodeURIComponent(table)}/range?$select=address,text`);
    this.tableCache.set(table, { at: this.now(), value });
    return value;
  }

  private invalidate(table: string) {
    this.tableCache.delete(table);
  }

  /** Every data row of the table, blanks included, with its sheet row number. */
  private async dataRows(sheet: SheetRef) {
    const range = await this.readTable(this.tableFor(sheet));
    const { sheet: sheetName, startRow } = parseAddress(range.address);
    return {
      sheetName,
      rows: range.text.slice(1).map((cells, rowIndex) => ({ rowIndex, sheetRow: startRow + 1 + rowIndex, data: rowToPanelist(cells) })),
    };
  }

  async listPanelists(sheet: SheetRef): Promise<PanelistRow[]> {
    const { rows } = await this.dataRows(sheet);
    return rows.filter((r) => r.data.name.trim()).map(({ rowIndex, data }) => ({ rowIndex, data }));
  }

  async findByName(sheet: SheetRef, name: string) {
    const key = normalizeName(name);
    return (await this.listPanelists(sheet)).filter((r) => normalizeName(r.data.name) === key);
  }

  async addPanelist(sheet: SheetRef, panelist: Panelist): Promise<PanelistRow> {
    const table = this.tableFor(sheet);
    this.invalidate(table);
    const { sheetName, rows } = await this.dataRows(sheet);
    const values = [FIELDS.map((f) => cellValue(panelist[f]))];
    const blank = rows.find((r) => FIELDS.every((f) => !r.data[f].trim()));
    let rowIndex: number;
    if (blank) {
      await this.wb.request('PATCH', rangePath(sheetName, `A${blank.sheetRow}:O${blank.sheetRow}`), { values });
      rowIndex = blank.rowIndex;
    } else {
      const added = await this.wb.request<{ index: number }>('POST', `/tables/${encodeURIComponent(table)}/rows/add`, { values });
      rowIndex = added?.index ?? rows.length;
    }
    this.invalidate(table);
    return { rowIndex, data: { ...panelist } };
  }

  async updatePanelist(sheet: SheetRef, rowIndex: number, changes: Partial<Panelist>) {
    const table = this.tableFor(sheet);
    const { sheet: sheetName, startRow } = parseAddress((await this.readTable(table)).address);
    const row = startRow + 1 + rowIndex;
    for (const run of contiguousRuns(Object.keys(changes) as FieldKey[])) {
      const address = `${COLUMN_BY_KEY[run[0]].letter}${row}:${COLUMN_BY_KEY[run.at(-1)!].letter}${row}`;
      await this.wb.request('PATCH', rangePath(sheetName, address), { values: [run.map((f) => cellValue(changes[f] ?? ''))] });
    }
    this.invalidate(table);
  }

  async clearPanelist(sheet: SheetRef, rowIndex: number) {
    await this.updatePanelist(sheet, rowIndex, emptyPanelist());
  }

  // ---------------------------------------------------------------- worksheets

  private async worksheetNames(): Promise<Set<string>> {
    if (this.sheetNames && this.now() - this.sheetNames.at < CACHE_MS) return this.sheetNames.names;
    const res = await this.wb.request<{ value: { name: string }[] }>('GET', '/worksheets?$select=name');
    this.sheetNames = { at: this.now(), names: new Set(res.value.map((w) => w.name)) };
    return this.sheetNames.names;
  }

  async hasTopicTab(topic: Topic) {
    return (await this.worksheetNames()).has(topic.tabName);
  }

  /**
   * Creates a green topic tab shaped like Panel Tracker: same header row, header
   * formatting, column widths and data validation, converted to a named table.
   */
  async createTopicTab(topic: Topic) {
    this.sheetNames = null;
    if (await this.hasTopicTab(topic)) return;
    const name = topic.tabName;
    const lastRow = TOPIC_TAB_ROWS + 1;
    await this.wb.request('POST', '/worksheets/add', { name });
    this.sheetNames = null;

    const header = await this.wb.request<RangeText>('GET', `${rangePath(SHEETS.tracker, 'A1:O1')}?$select=address,text`);
    await this.wb.request('PATCH', rangePath(name, 'A1:O1'), { values: header.text });

    await this.bestEffort('header format', async () => {
      const fill = await this.wb.request<{ color?: string }>('GET', `${rangePath(SHEETS.tracker, 'A1')}/format/fill`);
      const font = await this.wb.request<{ bold?: boolean; color?: string }>('GET', `${rangePath(SHEETS.tracker, 'A1')}/format/font`);
      if (fill?.color) await this.wb.request('PATCH', `${rangePath(name, 'A1:O1')}/format/fill`, { color: fill.color });
      await this.wb.request('PATCH', `${rangePath(name, 'A1:O1')}/format/font`, { bold: font?.bold ?? true, color: font?.color });
    });

    for (const c of COLUMNS) {
      await this.bestEffort(`width ${c.letter}`, async () => {
        const fmt = await this.wb.request<{ columnWidth?: number }>('GET', `${rangePath(SHEETS.tracker, `${c.letter}:${c.letter}`)}/format?$select=columnWidth`);
        if (fmt?.columnWidth) {
          await this.wb.request('PATCH', `${rangePath(name, `${c.letter}:${c.letter}`)}/format`, { columnWidth: fmt.columnWidth });
        }
      });
      await this.bestEffort(`validation ${c.letter}`, async () => {
        const dv = await this.wb.request<{ rule?: Record<string, unknown> }>('GET', `${rangePath(SHEETS.tracker, `${c.letter}2`)}/dataValidation`);
        if (dv?.rule && Object.values(dv.rule).some((v) => v)) {
          await this.wb.request('PATCH', `${rangePath(name, `${c.letter}2:${c.letter}${lastRow}`)}/dataValidation`, { rule: dv.rule });
        }
      });
    }

    await this.bestEffort('tab color', () => this.wb.request('PATCH', sheetPath(name), { tabColor: TOPIC_TAB_COLOR }));

    const table = await this.wb.request<{ id: string }>('POST', `${sheetPath(name)}/tables/add`, {
      address: `A1:O${lastRow}`,
      hasHeaders: true,
    });
    await this.wb.request('PATCH', `/tables/${encodeURIComponent(table.id)}`, { name: topic.tableName });
    this.sheetNames = null;
    logger.info('graph.tab_created', { tab: name, table: topic.tableName });
  }

  private async bestEffort(what: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      logger.warn('graph.best_effort_failed', { step: what, error: (err as Error).message });
    }
  }

  // ---------------------------------------------------------------- lists

  /** Reads each dropdown's list from Panel Tracker's own data validation (row 2). */
  async readLists(): Promise<DropdownLists> {
    const fallback = defaultLists(this.topics);
    const lists = { ...fallback };
    for (const field of DROPDOWN_FIELDS) {
      const letter = COLUMN_BY_KEY[field].letter;
      try {
        const dv = await this.wb.request<{ rule?: { list?: { source?: string } } }>(
          'GET',
          `${rangePath(SHEETS.tracker, `${letter}2`)}/dataValidation`,
        );
        const source = dv?.rule?.list?.source;
        if (!source) throw new Error('no list validation');
        const values = await this.resolveListSource(source);
        if (!values.length) throw new Error('empty list');
        lists[field] = values;
      } catch (err) {
        logger.warn('graph.list_fallback', { column: letter, error: (err as Error).message });
      }
    }
    return lists;
  }

  /** A validation source is either "a,b,c" or a reference like "=Lists!$A$1:$A$15" or "=PanelNames". */
  private async resolveListSource(source: string): Promise<string[]> {
    if (!source.startsWith('=')) return source.split(',').map((s) => s.trim()).filter(Boolean);
    const ref = source.slice(1);
    const path = ref.includes('!')
      ? (() => {
          const { sheet } = parseAddress(ref.replace(/\$/g, ''));
          return rangePath(sheet, ref.slice(ref.lastIndexOf('!') + 1).replace(/\$/g, ''));
        })()
      : `/names/${encodeURIComponent(ref)}/range`;
    const range = await this.wb.request<RangeText>('GET', `${path}?$select=address,text`);
    return range.text.flat().map((s) => String(s).trim()).filter(Boolean);
  }

  // ---------------------------------------------------------------- team

  private async usedRange(sheet: string): Promise<RangeText> {
    return this.wb.request<RangeText>('GET', `${sheetPath(sheet)}/usedRange(valuesOnly=true)?$select=address,text`);
  }

  async readTeam(): Promise<TeamMember[]> {
    const { text } = await this.usedRange(SHEETS.team);
    const [header = [], ...rows] = text;
    const col = (label: string) => header.findIndex((h) => squash(h).startsWith(squash(label)));
    const [id, name, role, topic] = [col('Slack'), col('Name'), col('Role'), col('Topic')];
    if (name < 0) throw new Error(`Team tab needs a header row: ${TEAM_HEADERS.join(' | ')}`);
    return rows
      .filter((r) => String(r[name] ?? '').trim())
      .map((r) => ({
        slackId: id >= 0 ? String(r[id] ?? '').trim() : '',
        name: String(r[name]).trim(),
        role: String(r[role] ?? '').trim().toLowerCase() === 'admin' ? 'admin' : 'owner',
        topic: topic >= 0 ? String(r[topic] ?? '').trim() : '',
      }));
  }

  async writeTeamMember(member: TeamMember) {
    const range = await this.usedRange(SHEETS.team);
    const { startRow } = parseAddress(range.address);
    const members = range.text.slice(1);
    const i = members.findIndex((r) =>
      member.slackId && String(r[0] ?? '').trim() ? r[0].trim() === member.slackId : normalizeName(String(r[1] ?? '')) === normalizeName(member.name),
    );
    const row = i >= 0 ? startRow + 1 + i : startRow + range.text.length;
    await this.wb.request('PATCH', rangePath(SHEETS.team, `A${row}:D${row}`), {
      values: [[member.slackId, member.name, member.role, member.topic].map(cellValue)],
    });
  }

  // ---------------------------------------------------------------- log + reference

  async appendLog(entry: LogEntry) {
    if (!this.logHeaders) {
      const head = await this.wb.request<RangeText>('GET', `${rangePath(SHEETS.log, '1:1')}/usedRange(valuesOnly=true)?$select=address,text`);
      this.logHeaders = head.text[0] ?? [];
    }
    const headers = this.logHeaders;
    const values = headers.map((h) => {
      const s = squash(h);
      if (s.startsWith('timestamp') || s === 'date' || s === 'time') return entry.timestamp;
      if (s.startsWith('submittedby') || s === 'by' || s === 'user') return entry.submittedBy;
      if (s.startsWith('panelistname') || s === 'name') return entry.panelistName;
      if (s === 'update' || s === 'change' || s === 'changes') return entry.update;
      const field = headerToField(h);
      return field ? (entry.fields[field] ?? '') : '';
    });
    const used = await this.usedRange(SHEETS.log);
    const { startRow, endRow } = parseAddress(used.address);
    const row = used.text.length ? endRow + 1 : startRow;
    const lastCol = columnLetter(Math.max(headers.length, 4));
    await this.wb.request('PATCH', rangePath(SHEETS.log, `A${row}:${lastCol}${row}`), {
      values: [values.length ? values.map(cellValue) : [entry.timestamp, entry.submittedBy, entry.panelistName, entry.update]],
    });
  }

  async listReference(): Promise<ReferenceRow[]> {
    if (this.referenceCache && this.now() - this.referenceCache.at < CACHE_MS) return this.referenceCache.rows;
    const { text } = await this.usedRange(SHEETS.reference);
    const [header = [], ...rows] = text;
    const map = header.map(headerToField);
    const out = rows
      .map((cells) => {
        const p = emptyPanelist();
        map.forEach((f, i) => f && (p[f] = String(cells[i] ?? '').trim()));
        return p;
      })
      .filter((p) => p.name);
    this.referenceCache = { at: this.now(), rows: out };
    return out;
  }
}

export function columnLetter(n: number): string {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}
