import type {
  DropdownLists,
  LogEntry,
  Panelist,
  PanelistRow,
  ReferenceRow,
  SheetRef,
  TeamMember,
  Topic,
} from '../domain/types.js';

/**
 * All sheet I/O goes through this interface. Slack code never talks to Graph,
 * so the auth route (or the whole backend) can change without touching it.
 */
export interface TrackerStore {
  /** Dropdown values, read from the workbook's own data validation lists. */
  readLists(): Promise<DropdownLists>;

  /** The Team tab: Slack user → role → topic. */
  readTeam(): Promise<TeamMember[]>;
  /** Upserts one Team row, matched on Slack ID, else on normalized name. */
  writeTeamMember(member: TeamMember): Promise<void>;

  hasTopicTab(topic: Topic): Promise<boolean>;
  /** Creates a green topic tab shaped like Panel Tracker. No-op if it exists. */
  createTopicTab(topic: Topic): Promise<void>;

  /** Non-blank rows (rows with a Name) of a topic tab or Panel Tracker. */
  listPanelists(sheet: SheetRef): Promise<PanelistRow[]>;
  /** Rows whose normalized Name matches. */
  findByName(sheet: SheetRef, name: string): Promise<PanelistRow[]>;
  /** Writes a full row into the first blank table row, or appends one. */
  addPanelist(sheet: SheetRef, panelist: Panelist): Promise<PanelistRow>;
  /** Writes only the given cells of one row. */
  updatePanelist(sheet: SheetRef, rowIndex: number, changes: Partial<Panelist>): Promise<void>;
  /** Blanks a row (used by Undo of an add and by resync). Row indexes stay stable. */
  clearPanelist(sheet: SheetRef, rowIndex: number): Promise<void>;

  appendLog(entry: LogEntry): Promise<void>;
  /** Last year's reference tab, read-only. */
  listReference(): Promise<ReferenceRow[]>;
}
