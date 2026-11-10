import { sameName } from '../domain/normalize.js';
import type { LogEntry, Panelist, PanelistRow, SheetRef, TeamMember, Topic } from '../domain/types.js';
import { errorFields, logger } from '../logger.js';
import type { PlanningTabs } from './sheets/PlanningTabs.js';
import type { TrackerStore } from './TrackerStore.js';

const TRACKER: SheetRef = { kind: 'tracker' };

/**
 * For workbooks whose panel tabs are hand-made planning sheets rather than tables:
 * Panel Tracker holds every speaker's full row (the panel is column K), and each
 * write to a panel also updates that panel's tab — its Potential Moderators /
 * Potential Panelists list and Confirmed slots — through PlanningTabs.
 *
 * To the service, a panel "tab" is just its rows in Panel Tracker, so the existing
 * mirror and resync logic becomes a harmless no-op.
 */
export class PlanningLayoutStore implements TrackerStore {
  readonly singleTable = true;

  constructor(
    private readonly inner: TrackerStore,
    private readonly planning: PlanningTabs,
  ) {}

  private async rowsFor(sheet: SheetRef): Promise<PanelistRow[]> {
    const rows = await this.inner.listPanelists(TRACKER);
    return sheet.kind === 'tracker' ? rows : rows.filter((r) => sameName(r.data.panelA, sheet.topic.panel));
  }

  private async rowAt(rowIndex: number): Promise<Panelist | null> {
    return (await this.inner.listPanelists(TRACKER)).find((r) => r.rowIndex === rowIndex)?.data ?? null;
  }

  /** Planning-tab updates never block the tracker write; failures are logged for a lead to fix. */
  private async syncTab(topic: Topic, before: Panelist | null, after: Panelist | null) {
    try {
      await this.planning.sync(topic, before, after);
    } catch (err) {
      const name = (after ?? before)?.name ?? '';
      logger.error('planning.sync_failed', { tab: topic.tabName, name, ...errorFields(err) });
      await this.inner
        .appendLog({ timestamp: new Date().toISOString(), submittedBy: 'Peter Panel', panelistName: name, update: `TAB UPDATE FAILED on ${topic.tabName}: ${(err as Error).message}`, fields: {} })
        .catch(() => undefined);
    }
  }

  listPanelists(sheet: SheetRef) {
    return this.rowsFor(sheet);
  }

  async findByName(sheet: SheetRef, name: string) {
    return (await this.rowsFor(sheet)).filter((r) => sameName(r.data.name, name));
  }

  async addPanelist(sheet: SheetRef, panelist: Panelist): Promise<PanelistRow> {
    if (sheet.kind === 'tracker') return this.inner.addPanelist(TRACKER, panelist);
    const data = { ...panelist, panelA: sheet.topic.panel };
    const row = await this.inner.addPanelist(TRACKER, data);
    await this.syncTab(sheet.topic, null, data);
    return row;
  }

  async updatePanelist(sheet: SheetRef, rowIndex: number, changes: Partial<Panelist>) {
    if (sheet.kind === 'tracker') return this.inner.updatePanelist(TRACKER, rowIndex, changes);
    const before = await this.rowAt(rowIndex);
    await this.inner.updatePanelist(TRACKER, rowIndex, changes);
    if (before) await this.syncTab(sheet.topic, before, { ...before, ...changes });
  }

  async clearPanelist(sheet: SheetRef, rowIndex: number) {
    if (sheet.kind === 'tracker') return this.inner.clearPanelist(TRACKER, rowIndex);
    const before = await this.rowAt(rowIndex);
    await this.inner.clearPanelist(TRACKER, rowIndex);
    if (before) await this.syncTab(sheet.topic, before, null);
  }

  /** Every configured panel "has a tab": its rows live in Panel Tracker. */
  async hasTopicTab(_topic: Topic) {
    return true;
  }

  async createTopicTab(_topic: Topic) {
    // Planning tabs are made by hand from the team's template; nothing to create.
  }

  readLists() {
    return this.inner.readLists();
  }
  readTeam() {
    return this.inner.readTeam();
  }
  writeTeamMember(member: TeamMember) {
    return this.inner.writeTeamMember(member);
  }
  appendLog(entry: LogEntry) {
    return this.inner.appendLog(entry);
  }
  listReference() {
    return this.inner.listReference();
  }
}
