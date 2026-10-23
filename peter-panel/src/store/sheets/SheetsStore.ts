import { normalizeName } from '../../domain/normalize.js';
import {
  COLUMN_BY_KEY,
  COLUMNS,
  DROPDOWN_FIELDS,
  emptyPanelist,
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
import { GraphClient, GraphError } from '../graph/GraphClient.js';
import { SHEETS, cellValue, columnLetter, contiguousRuns, headerToField, TOPIC_TAB_ROWS } from '../graph/GraphStore.js';
import type { TrackerStore } from '../TrackerStore.js';

export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
/** Green tab colour for topic tabs (#00B050). */
export const TOPIC_TAB_RGB = { red: 0, green: 176 / 255, blue: 80 / 255 };
const CACHE_MS = 60_000;

interface SheetProps {
  sheetId: number;
  title: string;
  hidden?: boolean;
  gridProperties?: { rowCount?: number; columnCount?: number };
}

interface DataValidation {
  condition?: { type?: string; values?: { userEnteredValue?: string }[] };
}

/** Quotes a sheet title for A1 notation: 'Bob''s Tab'!A1:O. */
export function a1(title: string, range: string): string {
  return `'${title.replace(/'/g, "''")}'!${range}`;
}

function pad(row: string[] | undefined, n: number): string[] {
  const out = (row ?? []).map((v) => String(v ?? ''));
  while (out.length < n) out.push('');
  return out;
}

function rowToPanelist(cells: string[]): Panelist {
  const p = emptyPanelist();
  FIELDS.forEach((f, i) => (p[f] = cells[i] ?? ''));
  return p;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * TrackerStore backed by a Google Sheet, through the Sheets API v4 with a service
 * account. Same tabs and columns as the Excel workbook; rows are addressed by
 * position (row 2 = data row 0), and only changed cells are written.
 */
export class SheetsStore implements TrackerStore {
  private meta: { at: number; sheets: SheetProps[] } | null = null;
  private rowsCache = new Map<string, { at: number; rows: string[][] }>();
  private referenceCache: { at: number; rows: ReferenceRow[] } | null = null;
  private logHeaders: string[] | null = null;

  constructor(
    private readonly api: GraphClient,
    private readonly spreadsheetId: string,
    private readonly topics: Topic[],
    private readonly now: () => number = Date.now,
  ) {}

  static client(tokens: ConstructorParameters<typeof GraphClient>[0], opts: ConstructorParameters<typeof GraphClient>[1] = {}) {
    return new GraphClient(tokens, { baseUrl: SHEETS_API, label: 'Google Sheets', ...opts });
  }

  private req<T>(method: string, path: string, body?: unknown) {
    return this.api.request<T>(method, `/${this.spreadsheetId}${path}`, body);
  }

  // ---------------------------------------------------------------- low level

  async getValues(range: string): Promise<string[][]> {
    const res = await this.req<{ values?: string[][] }>(
      'GET',
      `/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
    );
    return res?.values ?? [];
  }

  private async writeValues(data: { range: string; values: string[][] }[]) {
    if (!data.length) return;
    await this.req('POST', '/values:batchUpdate', {
      valueInputOption: 'USER_ENTERED',
      data: data.map((d) => ({ ...d, values: d.values.map((r) => r.map(cellValue)) })),
    });
  }

  async batchUpdate<T = { replies?: unknown[] }>(requests: unknown[]): Promise<T> {
    return this.req<T>('POST', ':batchUpdate', { requests });
  }

  async sheets(force = false): Promise<SheetProps[]> {
    if (!force && this.meta && this.now() - this.meta.at < CACHE_MS) return this.meta.sheets;
    const res = await this.req<{ sheets: { properties: SheetProps }[] }>(
      'GET',
      '?fields=sheets.properties(sheetId,title,hidden,gridProperties(rowCount,columnCount))',
    );
    this.meta = { at: this.now(), sheets: res.sheets.map((s) => s.properties) };
    return this.meta.sheets;
  }

  async sheet(title: string): Promise<SheetProps | undefined> {
    return (await this.sheets()).find((s) => s.title === title);
  }

  /** Makes sure the grid has at least `rows` rows, adding some headroom if not. */
  private async ensureRows(title: string, rows: number) {
    const s = await this.sheet(title);
    if (!s) throw new Error(`Tab "${title}" not found in the Google Sheet`);
    const have = s.gridProperties?.rowCount ?? 0;
    if (have >= rows) return;
    await this.batchUpdate([{ appendDimension: { sheetId: s.sheetId, dimension: 'ROWS', length: rows - have + 100 } }]);
    this.meta = null;
  }

  /** Friendly startup check: can the service account open the sheet? */
  async verifyAccess(serviceAccount: string) {
    try {
      const titles = (await this.sheets(true)).map((s) => s.title);
      const missing = [SHEETS.tracker, SHEETS.log, SHEETS.team].filter((t) => !titles.includes(t));
      if (missing.length) {
        throw new Error(
          `The Google Sheet is missing these tabs: ${missing.join(', ')}. Run \`npm run setup-sheet\` (it creates Team), ` +
            `and check the others are named exactly. Tabs found: ${titles.join(', ')}`,
        );
      }
    } catch (err) {
      if (err instanceof GraphError && (err.status === 403 || err.status === 404)) {
        throw new Error(
          `Can't open the Google Sheet. Share it with ${serviceAccount} as an Editor, and check GOOGLE_SHEET_ID. (${err.message})`,
        );
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------- panelist rows

  private titleFor(sheet: SheetRef) {
    return sheet.kind === 'tracker' ? SHEETS.tracker : sheet.topic.tabName;
  }

  /** Data rows (row 2 onward) as 15-cell arrays, blanks included. Cached 60 s. */
  private async rawRows(title: string): Promise<string[][]> {
    const hit = this.rowsCache.get(title);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = (await this.getValues(a1(title, 'A2:O'))).map((r) => pad(r, 15));
    this.rowsCache.set(title, { at: this.now(), rows });
    return rows;
  }

  async listPanelists(sheet: SheetRef): Promise<PanelistRow[]> {
    return (await this.rawRows(this.titleFor(sheet)))
      .map((cells, rowIndex) => ({ rowIndex, data: rowToPanelist(cells) }))
      .filter((r) => r.data.name.trim());
  }

  async findByName(sheet: SheetRef, name: string) {
    const key = normalizeName(name);
    return (await this.listPanelists(sheet)).filter((r) => normalizeName(r.data.name) === key);
  }

  async addPanelist(sheet: SheetRef, panelist: Panelist): Promise<PanelistRow> {
    const title = this.titleFor(sheet);
    this.rowsCache.delete(title);
    const rows = await this.rawRows(title);
    let rowIndex = rows.findIndex((cells) => cells.every((c) => !c.trim()));
    if (rowIndex < 0) rowIndex = rows.length;
    const sheetRow = rowIndex + 2;
    await this.ensureRows(title, sheetRow);
    await this.writeValues([{ range: a1(title, `A${sheetRow}:O${sheetRow}`), values: [FIELDS.map((f) => panelist[f])] }]);
    this.rowsCache.delete(title);
    return { rowIndex, data: { ...panelist } };
  }

  async updatePanelist(sheet: SheetRef, rowIndex: number, changes: Partial<Panelist>) {
    const title = this.titleFor(sheet);
    const row = rowIndex + 2;
    await this.writeValues(
      contiguousRuns(Object.keys(changes) as FieldKey[]).map((run) => ({
        range: a1(title, `${COLUMN_BY_KEY[run[0]].letter}${row}:${COLUMN_BY_KEY[run.at(-1)!].letter}${row}`),
        values: [run.map((f) => changes[f] ?? '')],
      })),
    );
    this.rowsCache.delete(title);
  }

  async clearPanelist(sheet: SheetRef, rowIndex: number) {
    await this.updatePanelist(sheet, rowIndex, emptyPanelist());
  }

  // ---------------------------------------------------------------- topic tabs

  async hasTopicTab(topic: Topic) {
    return !!(await this.sheet(topic.tabName));
  }

  /**
   * Creates a green topic tab shaped like Panel Tracker: header row, header and
   * cell formatting, data validation (dropdowns) and column widths.
   */
  async createTopicTab(topic: Topic) {
    const sheets = await this.sheets(true);
    if (sheets.some((s) => s.title === topic.tabName)) return;
    const tracker = sheets.find((s) => s.title === SHEETS.tracker);
    if (!tracker) throw new Error(`Tab "${SHEETS.tracker}" not found in the Google Sheet`);
    const rows = TOPIC_TAB_ROWS + 1;

    const added = await this.batchUpdate<{ replies: { addSheet: { properties: SheetProps } }[] }>([
      {
        addSheet: {
          properties: {
            title: topic.tabName,
            tabColorStyle: { rgbColor: TOPIC_TAB_RGB },
            gridProperties: { rowCount: rows, columnCount: COLUMNS.length, frozenRowCount: 1 },
          },
        },
      },
    ]);
    const sheetId = added.replies[0].addSheet.properties.sheetId;
    this.meta = null;

    const copyRows = Math.min(rows, tracker.gridProperties?.rowCount ?? rows);
    const range = (sid: number, endRow: number) => ({ sheetId: sid, startRowIndex: 0, endRowIndex: endRow, startColumnIndex: 0, endColumnIndex: COLUMNS.length });
    const requests: unknown[] = [
      // Formatting and dropdowns for the header and data rows, then the header text.
      { copyPaste: { source: range(tracker.sheetId, copyRows), destination: range(sheetId, copyRows), pasteType: 'PASTE_FORMAT' } },
      { copyPaste: { source: range(tracker.sheetId, 1), destination: range(sheetId, 1), pasteType: 'PASTE_VALUES' } },
    ];
    try {
      const widths = await this.req<{ sheets: { data: { columnMetadata?: { pixelSize?: number }[] }[] }[] }>(
        'GET',
        `?ranges=${encodeURIComponent(a1(SHEETS.tracker, 'A1:O1'))}&fields=sheets.data.columnMetadata.pixelSize`,
      );
      (widths.sheets[0]?.data[0]?.columnMetadata ?? []).forEach((c, i) => {
        if (c.pixelSize) {
          requests.push({
            updateDimensionProperties: {
              range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
              properties: { pixelSize: c.pixelSize },
              fields: 'pixelSize',
            },
          });
        }
      });
    } catch (err) {
      logger.warn('sheets.widths_failed', { error: (err as Error).message });
    }
    await this.batchUpdate(requests);
    logger.info('sheets.tab_created', { tab: topic.tabName });
  }

  // ---------------------------------------------------------------- lists

  /** Reads each dropdown's values from Panel Tracker's own data validation (row 2). */
  async readLists(): Promise<DropdownLists> {
    const lists = { ...defaultLists(this.topics) };
    let cells: { dataValidation?: DataValidation }[] = [];
    try {
      const res = await this.req<{ sheets: { data: { rowData?: { values?: { dataValidation?: DataValidation }[] }[] }[] }[] }>(
        'GET',
        `?ranges=${encodeURIComponent(a1(SHEETS.tracker, 'A2:O2'))}&fields=sheets.data.rowData.values.dataValidation`,
      );
      cells = res.sheets[0]?.data[0]?.rowData?.[0]?.values ?? [];
    } catch (err) {
      logger.warn('sheets.lists_failed', { error: (err as Error).message });
    }
    for (const field of DROPDOWN_FIELDS) {
      const col = FIELDS.indexOf(field);
      const cond = cells[col]?.dataValidation?.condition;
      try {
        let values: string[] = [];
        if (cond?.type === 'ONE_OF_LIST') values = (cond.values ?? []).map((v) => (v.userEnteredValue ?? '').trim()).filter(Boolean);
        else if (cond?.type === 'ONE_OF_RANGE' && cond.values?.[0]?.userEnteredValue) {
          const ref = cond.values[0].userEnteredValue.replace(/^=/, '').replace(/\$/g, '');
          values = (await this.getValues(ref)).flat().map((v) => String(v).trim()).filter(Boolean);
        }
        if (!values.length) throw new Error(cond ? `unsupported validation ${cond.type}` : 'no dropdown');
        lists[field] = values;
      } catch (err) {
        logger.warn('sheets.list_fallback', { column: COLUMN_BY_KEY[field].letter, error: (err as Error).message });
      }
    }
    return lists;
  }

  // ---------------------------------------------------------------- team

  async readTeam(): Promise<TeamMember[]> {
    const [header = [], ...rows] = await this.getValues(a1(SHEETS.team, 'A1:D'));
    const col = (label: string) => header.findIndex((h) => squash(h).startsWith(squash(label)));
    const [id, name, role, topic] = [col('Slack'), col('Name'), col('Role'), col('Topic')];
    if (name < 0) throw new Error('Team tab needs a header row: Slack User ID | Name | Role | Topic');
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
    const values = await this.getValues(a1(SHEETS.team, 'A1:D'));
    const rows = values.slice(1);
    const i = rows.findIndex((r) =>
      member.slackId && String(r[0] ?? '').trim()
        ? String(r[0]).trim() === member.slackId
        : normalizeName(String(r[1] ?? '')) === normalizeName(member.name),
    );
    const row = i >= 0 ? i + 2 : Math.max(values.length, 1) + 1;
    await this.ensureRows(SHEETS.team, row);
    await this.writeValues([{ range: a1(SHEETS.team, `A${row}:D${row}`), values: [[member.slackId, member.name, member.role, member.topic]] }]);
  }

  // ---------------------------------------------------------------- log + reference

  async appendLog(entry: LogEntry) {
    this.logHeaders ??= (await this.getValues(a1(SHEETS.log, '1:1')))[0] ?? [];
    const headers = this.logHeaders;
    const values = headers.length
      ? headers.map((h) => {
          const s = squash(h);
          if (s.startsWith('timestamp') || s === 'date' || s === 'time') return entry.timestamp;
          if (s.startsWith('submittedby') || s === 'by' || s === 'user') return entry.submittedBy;
          if (s.startsWith('panelistname') || s === 'name') return entry.panelistName;
          if (s === 'update' || s === 'change' || s === 'changes') return entry.update;
          const field = headerToField(h);
          return field ? (entry.fields[field] ?? '') : '';
        })
      : [entry.timestamp, entry.submittedBy, entry.panelistName, entry.update];
    const lastCol = columnLetter(Math.max(values.length, 4));
    await this.req(
      'POST',
      `/values/${encodeURIComponent(a1(SHEETS.log, `A1:${lastCol}1`))}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values: [values.map(cellValue)] },
    );
  }

  async listReference(): Promise<ReferenceRow[]> {
    if (this.referenceCache && this.now() - this.referenceCache.at < CACHE_MS) return this.referenceCache.rows;
    let values: string[][] = [];
    try {
      values = await this.getValues(a1(SHEETS.reference, 'A1:Z'));
    } catch (err) {
      logger.warn('sheets.reference_unavailable', { error: (err as Error).message });
    }
    const [header = [], ...rows] = values;
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
