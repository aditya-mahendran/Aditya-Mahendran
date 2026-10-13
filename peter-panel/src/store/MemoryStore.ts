import { normalizeName } from '../domain/normalize.js';
import {
  emptyPanelist,
  FIELDS,
  type DropdownLists,
  type LogEntry,
  type Panelist,
  type PanelistRow,
  type ReferenceRow,
  type SheetRef,
  type TeamMember,
  type Topic,
} from '../domain/types.js';
import type { TrackerStore } from './TrackerStore.js';

export interface MemoryStoreSeed {
  lists: DropdownLists;
  team?: TeamMember[];
  reference?: ReferenceRow[];
  trackerRows?: Panelist[];
}

/** In-memory TrackerStore for tests and local development. */
export class MemoryStore implements TrackerStore {
  readonly tabs = new Map<string, (Panelist | null)[]>();
  readonly tracker: (Panelist | null)[] = [];
  readonly log: LogEntry[] = [];
  team: TeamMember[];
  lists: DropdownLists;
  reference: ReferenceRow[];
  /** Set to make the next N writes to a sheet fail, for failure-path tests. */
  failNextWrites: { sheet: 'tracker' | string; count: number } | null = null;

  constructor(seed: MemoryStoreSeed) {
    this.lists = structuredClone(seed.lists);
    this.team = structuredClone(seed.team ?? []);
    this.reference = structuredClone(seed.reference ?? []);
    for (const r of seed.trackerRows ?? []) this.tracker.push({ ...r });
  }

  private rows(sheet: SheetRef): (Panelist | null)[] {
    if (sheet.kind === 'tracker') return this.tracker;
    const rows = this.tabs.get(sheet.topic.tabName);
    if (!rows) throw new Error(`Worksheet "${sheet.topic.tabName}" not found`);
    return rows;
  }

  private maybeFail(sheet: SheetRef) {
    const key = sheet.kind === 'tracker' ? 'tracker' : sheet.topic.tabName;
    if (this.failNextWrites && this.failNextWrites.sheet === key && this.failNextWrites.count > 0) {
      this.failNextWrites.count--;
      throw new Error(`Simulated write failure on ${key}`);
    }
  }

  async readLists() {
    return structuredClone(this.lists);
  }

  async readTeam() {
    return structuredClone(this.team);
  }

  async writeTeamMember(member: TeamMember) {
    const i = this.team.findIndex((m) =>
      member.slackId && m.slackId ? m.slackId === member.slackId : normalizeName(m.name) === normalizeName(member.name),
    );
    if (i >= 0) this.team[i] = { ...member };
    else this.team.push({ ...member });
  }

  async hasTopicTab(topic: Topic) {
    return this.tabs.has(topic.tabName);
  }

  async createTopicTab(topic: Topic) {
    if (!this.tabs.has(topic.tabName)) this.tabs.set(topic.tabName, []);
  }

  async listPanelists(sheet: SheetRef): Promise<PanelistRow[]> {
    return this.rows(sheet)
      .map((data, rowIndex) => (data && data.name.trim() ? { rowIndex, data: { ...data } } : null))
      .filter((r): r is PanelistRow => r !== null);
  }

  async findByName(sheet: SheetRef, name: string) {
    const key = normalizeName(name);
    return (await this.listPanelists(sheet)).filter((r) => normalizeName(r.data.name) === key);
  }

  async addPanelist(sheet: SheetRef, panelist: Panelist): Promise<PanelistRow> {
    this.maybeFail(sheet);
    const rows = this.rows(sheet);
    let rowIndex = rows.findIndex((r) => !r || FIELDS.every((f) => !r[f].trim()));
    if (rowIndex < 0) rowIndex = rows.push(null) - 1;
    rows[rowIndex] = { ...panelist };
    return { rowIndex, data: { ...panelist } };
  }

  async updatePanelist(sheet: SheetRef, rowIndex: number, changes: Partial<Panelist>) {
    this.maybeFail(sheet);
    const rows = this.rows(sheet);
    const row = rows[rowIndex];
    if (!row) throw new Error(`Row ${rowIndex} not found`);
    rows[rowIndex] = { ...row, ...changes };
  }

  async clearPanelist(sheet: SheetRef, rowIndex: number) {
    this.maybeFail(sheet);
    const rows = this.rows(sheet);
    if (rowIndex < rows.length) rows[rowIndex] = emptyPanelist();
  }

  async appendLog(entry: LogEntry) {
    this.log.push(structuredClone(entry));
  }

  async listReference() {
    return structuredClone(this.reference);
  }
}
