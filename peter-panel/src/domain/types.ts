/** Field keys for the 15 tracker columns, in sheet order A–O. */
export const FIELDS = [
  'priority',
  'lastUpdated',
  'status',
  'confirmed',
  'name',
  'role',
  'company',
  'alum',
  'description',
  'speakerType',
  'panelA',
  'panelB',
  'notes',
  'location',
  'connection',
] as const;

export type FieldKey = (typeof FIELDS)[number];

/** One panelist row. Every cell is stored as the text Excel displays. */
export type Panelist = Record<FieldKey, string>;

export interface ColumnDef {
  key: FieldKey;
  letter: string;
  header: string;
}

export const COLUMNS: ColumnDef[] = [
  { key: 'priority', letter: 'A', header: 'Priority' },
  { key: 'lastUpdated', letter: 'B', header: 'Last Updated on (MM/DD)' },
  { key: 'status', letter: 'C', header: 'Outreach Status' },
  { key: 'confirmed', letter: 'D', header: 'Participation Confirmed' },
  { key: 'name', letter: 'E', header: 'Name' },
  { key: 'role', letter: 'F', header: 'Role/Title' },
  { key: 'company', letter: 'G', header: 'Company' },
  { key: 'alum', letter: 'H', header: 'Kellogg Alum?' },
  { key: 'description', letter: 'I', header: 'Speaker Description' },
  { key: 'speakerType', letter: 'J', header: 'Speaker Type' },
  { key: 'panelA', letter: 'K', header: 'For which panel (option A)?' },
  { key: 'panelB', letter: 'L', header: 'For any other panel (option B)?' },
  { key: 'notes', letter: 'M', header: 'Notes' },
  { key: 'location', letter: 'N', header: 'Location' },
  { key: 'connection', letter: 'O', header: 'Connection' },
];

export const COLUMN_BY_KEY: Record<FieldKey, ColumnDef> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c]),
) as Record<FieldKey, ColumnDef>;

/** Short labels used in diffs, Slack messages and the audit log. */
export const FIELD_LABELS: Record<FieldKey, string> = {
  priority: 'Priority',
  lastUpdated: 'Last Updated',
  status: 'Status',
  confirmed: 'Confirmed',
  name: 'Name',
  role: 'Role/Title',
  company: 'Company',
  alum: 'Kellogg Alum?',
  description: 'Speaker Description',
  speakerType: 'Speaker Type',
  panelA: 'Panel',
  panelB: 'Option B panel',
  notes: 'Notes',
  location: 'Location',
  connection: 'Connection',
};

/** Fields a user can type into the Add / Update modals. */
export const USER_FIELDS: FieldKey[] = [
  'name',
  'role',
  'company',
  'alum',
  'speakerType',
  'priority',
  'status',
  'description',
  'panelB',
  'location',
  'connection',
];

/** Fields whose values must come from the workbook's data validation lists. */
export const DROPDOWN_FIELDS = ['priority', 'status', 'confirmed', 'alum', 'speakerType', 'panelA', 'panelB'] as const;
export type DropdownField = (typeof DROPDOWN_FIELDS)[number];
export type DropdownLists = Record<DropdownField, string[]>;

export function emptyPanelist(): Panelist {
  return Object.fromEntries(FIELDS.map((f) => [f, ''])) as Panelist;
}

export interface Topic {
  id: string;
  number: number;
  /** Panel name exactly as written in column K. */
  panel: string;
  focus: string;
  tabName: string;
  tableName: string;
  alias: string;
}

export type Role = 'owner' | 'admin';

export interface TeamMember {
  slackId: string;
  name: string;
  role: Role;
  /** Panel name (column K value) the owner picked, or '' if none yet. */
  topic: string;
}

/** Where a row lives: a green topic tab, or the overall Panel Tracker. */
export type SheetRef = { kind: 'topic'; topic: Topic } | { kind: 'tracker' };

export interface PanelistRow {
  /** 0-based index of the data row inside the sheet's table. */
  rowIndex: number;
  data: Panelist;
}

export interface LogEntry {
  timestamp: string;
  submittedBy: string;
  panelistName: string;
  update: string;
  /** Only the fields that changed, written to their own columns. */
  fields: Partial<Panelist>;
}

/** A row from last year's reference tab. Same column layout as the tracker. */
export type ReferenceRow = Panelist;
