import { describe, expect, it } from 'vitest';
import { normalizeName, sameName } from '../src/domain/normalize.js';
import {
  appendNote,
  applyAutoFields,
  changedFields,
  confirmedValue,
  diffLine,
  isConfirmed,
  rowVersion,
  statusBucket,
  validatePanelist,
} from '../src/domain/rules.js';
import { chicagoMonthDay, chicagoTimestamp, daysSinceMonthDay } from '../src/domain/time.js';
import { emptyPanelist } from '../src/domain/types.js';
import { defaultLists } from '../src/store/defaults.js';
import { NOW, topics } from './helpers.js';

const lists = defaultLists(topics);
const row = (o: Partial<ReturnType<typeof emptyPanelist>> = {}) => ({ ...emptyPanelist(), name: 'Joe J', ...o });

describe('names', () => {
  it('matches case- and whitespace-insensitively', () => {
    expect(normalizeName('  Joe   JOHNSON ')).toBe('joe johnson');
    expect(sameName('Joe Johnson', 'joe  johnson')).toBe(true);
    expect(sameName('Joe Johnson', 'Joe Johnston')).toBe(false);
  });
});

describe('time', () => {
  it('formats Chicago dates', () => {
    expect(chicagoMonthDay(NOW)).toBe('10/13');
    expect(chicagoTimestamp(NOW)).toBe('10/13/2026 10:00 CDT');
    // 03:00 UTC on Oct 14 is still Oct 13 in Chicago.
    expect(chicagoMonthDay(new Date('2026-10-14T03:00:00Z'))).toBe('10/13');
  });

  it('counts days since an MM/DD cell, rolling future dates back a year', () => {
    expect(daysSinceMonthDay('10/06', NOW)).toBe(7);
    expect(daysSinceMonthDay('10/13', NOW)).toBe(0);
    expect(daysSinceMonthDay('12/25', NOW)).toBe(292);
    expect(daysSinceMonthDay('10/1/2026', NOW)).toBe(12);
    expect(daysSinceMonthDay('soon', NOW)).toBeUndefined();
  });
});

describe('notes', () => {
  it('appends with date and author and keeps history', () => {
    const first = appendNote('', 'Intro via Gia', 'Keanan Crasto', NOW);
    expect(first).toBe('10/13 (Keanan Crasto): Intro via Gia');
    const second = appendNote(first, '  Replied, interested ', 'Adi Mahendran', NOW);
    expect(second).toBe('10/13 (Keanan Crasto): Intro via Gia\n10/13 (Adi Mahendran): Replied, interested');
  });
});

describe('auto fields (FR-4)', () => {
  it('sets B to today on every write', () => {
    expect(applyAutoFields(null, row(), lists, NOW).lastUpdated).toBe('10/13');
  });

  it('sets D to the workbook YES value when status becomes Confirmed, and clears it when it moves off', () => {
    expect(confirmedValue(lists)).toBe('YES 🥳');
    const before = row({ status: 'Interested' });
    const confirmed = applyAutoFields(before, { ...before, status: 'Confirmed' }, lists, NOW);
    expect(confirmed.confirmed).toBe('YES 🥳');
    const off = applyAutoFields(confirmed, { ...confirmed, status: 'Declined' }, lists, NOW);
    expect(off.confirmed).toBe('');
  });

  it('treats both YES 🥳 and Yes as confirmed', () => {
    expect(isConfirmed({ status: '', confirmed: 'Yes' })).toBe(true);
    expect(isConfirmed({ status: '', confirmed: 'YES 🥳' })).toBe(true);
    expect(statusBucket({ status: 'Interested', confirmed: 'Yes' })).toBe('Confirmed');
  });
});

describe('diff', () => {
  it('produces a one-line diff and skips column B', () => {
    const before = row({ status: 'Outreach 1 Sent', lastUpdated: '10/01' });
    const after = { ...before, status: 'Interested', company: 'Acme', lastUpdated: '10/13' };
    expect(changedFields(before, after)).toEqual(['lastUpdated', 'status', 'company']);
    expect(diffLine(before, after)).toBe('Status: Outreach 1 Sent → Interested; Company: (blank) → Acme');
  });

  it('shows only the new note', () => {
    const before = row({ notes: '10/01 (A): old' });
    const after = { ...before, notes: '10/01 (A): old\n10/13 (B): new' };
    expect(diffLine(before, after)).toBe('Note added: 10/13 (B): new');
  });

  it('ignores whitespace-only changes', () => {
    expect(changedFields(row({ company: 'Acme' }), row({ company: ' Acme ' }))).toEqual([]);
  });
});

describe('validation', () => {
  it('requires a name and dropdown values from the workbook lists', () => {
    expect(validatePanelist(row({ name: '' }), lists).name).toBeDefined();
    expect(validatePanelist(row({ status: 'Maybe' }), lists).status).toMatch(/isn't in the workbook's list/);
    expect(validatePanelist(row({ status: 'Interested', alum: '--', panelA: 'Air Time' }), lists)).toEqual({});
  });
});

describe('status buckets', () => {
  it.each([
    ['Confirmed', 'Confirmed'],
    ['Interested', 'Interested'],
    ['Outreach 2 Sent', 'In outreach'],
    ['Meeting Scheduled', 'In outreach'],
    ['Potential Outreach', 'Not started'],
    ['', 'Not started'],
    ['Declined - Unavailable', 'Closed'],
    ['Unresponsive', 'Closed'],
  ])('%s → %s', (status, bucket) => {
    expect(statusBucket({ status, confirmed: '' })).toBe(bucket);
  });
});

describe('rowVersion', () => {
  it('changes when any cell changes', () => {
    expect(rowVersion(row())).toBe(rowVersion(row()));
    expect(rowVersion(row())).not.toBe(rowVersion(row({ notes: 'x' })));
  });
});
