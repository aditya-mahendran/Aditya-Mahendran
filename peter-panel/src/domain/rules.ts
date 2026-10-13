import { FIELD_LABELS, FIELDS, type DropdownLists, type FieldKey, type Panelist } from './types.js';
import { sameValue } from './normalize.js';
import { chicagoMonthDay } from './time.js';

export const DEFAULT_STATUS = 'Potential Outreach';
export const CONFIRMED_STATUS = 'Confirmed';

/** The "YES 🥳" value from the workbook's own list, so it always passes validation. */
export function confirmedValue(lists: DropdownLists): string {
  return lists.confirmed.find((v) => v.trim().toUpperCase().startsWith('YES') && v.trim() !== 'Yes') ??
    lists.confirmed[0] ??
    'YES 🥳';
}

/** Both "YES 🥳" and "Yes" count as confirmed (data issue noted in the spec). */
export function isConfirmed(p: Pick<Panelist, 'status' | 'confirmed'>): boolean {
  return sameValue(p.status, CONFIRMED_STATUS) || /^yes/i.test(p.confirmed.trim());
}

export function isDeclined(status: string): boolean {
  return /^declined/i.test(status.trim());
}

/** Appends a note as "MM/DD (Name): text", keeping earlier notes in the cell. */
export function appendNote(existing: string, text: string, author: string, now: Date): string {
  const note = `${chicagoMonthDay(now)} (${author}): ${text.trim()}`;
  return existing.trim() ? `${existing.trimEnd()}\n${note}` : note;
}

/**
 * FR-4 auto fields. Given the row before (or null for an add) and the proposed
 * row after, sets B = today, and keeps D in step with Confirmed status.
 */
export function applyAutoFields(
  before: Panelist | null,
  after: Panelist,
  lists: DropdownLists,
  now: Date,
): Panelist {
  const next = { ...after, lastUpdated: chicagoMonthDay(now) };
  const wasConfirmed = before ? sameValue(before.status, CONFIRMED_STATUS) : false;
  const nowConfirmed = sameValue(next.status, CONFIRMED_STATUS);
  if (nowConfirmed && !wasConfirmed) next.confirmed = confirmedValue(lists);
  if (!nowConfirmed && wasConfirmed) next.confirmed = '';
  return next;
}

/** Fields whose value differs between two rows. */
export function changedFields(before: Panelist, after: Panelist): FieldKey[] {
  return FIELDS.filter((f) => !sameValue(before[f], after[f]));
}

const MAX_DIFF_VALUE = 60;
function short(v: string): string {
  const one = v.replace(/\s+/g, ' ').trim();
  return one.length > MAX_DIFF_VALUE ? `${one.slice(0, MAX_DIFF_VALUE - 1)}…` : one || '(blank)';
}

/**
 * One-line diff for the audit log, e.g. "Status: Outreach 1 Sent → Interested".
 * Column B is left out (it changes on every write) and notes show only the new note.
 */
export function diffLine(before: Panelist, after: Panelist, fields: FieldKey[] = changedFields(before, after)): string {
  const parts: string[] = [];
  for (const f of fields) {
    if (f === 'lastUpdated') continue;
    if (f === 'notes') {
      const added = after.notes.startsWith(before.notes) ? after.notes.slice(before.notes.length) : after.notes;
      parts.push(`Note added: ${short(added)}`);
      continue;
    }
    parts.push(`${FIELD_LABELS[f]}: ${short(before[f])} → ${short(after[f])}`);
  }
  return parts.join('; ');
}

export type ValidationErrors = Partial<Record<FieldKey, string>>;

/** Checks required fields and that every dropdown value is one the workbook accepts. */
export function validatePanelist(p: Panelist, lists: DropdownLists): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!p.name.trim()) errors.name = 'Name is required.';
  for (const field of Object.keys(lists) as (keyof DropdownLists)[]) {
    const value = p[field].trim();
    if (!value || field === 'confirmed') continue;
    if (!lists[field].some((allowed) => allowed.trim() === value)) {
      errors[field] = `"${value}" isn't in the workbook's list for ${FIELD_LABELS[field]}.`;
    }
  }
  return errors;
}

/** Status buckets used by /panel status and the weekly digest. */
export type StatusBucket = 'Confirmed' | 'Interested' | 'In outreach' | 'Not started' | 'Closed';
export const STATUS_BUCKETS: StatusBucket[] = ['Confirmed', 'Interested', 'In outreach', 'Not started', 'Closed'];

export function statusBucket(p: Pick<Panelist, 'status' | 'confirmed'>): StatusBucket {
  if (isConfirmed(p)) return 'Confirmed';
  const s = p.status.trim().toLowerCase();
  if (s === 'interested') return 'Interested';
  if (['outreach 1 sent', 'outreach 2 sent', 'meeting scheduled', 'formal invite sent'].includes(s)) return 'In outreach';
  if (s === '' || s === 'potential outreach') return 'Not started';
  return 'Closed';
}

/** Short stable hash of a row, used to spot edits made while a modal was open. */
export function rowVersion(p: Panelist): string {
  const text = FIELDS.map((f) => (p[f] ?? '').trim()).join('\u0001');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
