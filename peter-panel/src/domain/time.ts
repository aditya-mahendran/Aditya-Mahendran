export const TZ = 'America/Chicago';

function parts(date: Date): Record<string, string> {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

/** Column B format: MM/DD in Chicago time. */
export function chicagoMonthDay(date: Date): string {
  const p = parts(date);
  return `${p.month}/${p.day}`;
}

/** Update Log timestamp, e.g. "10/13/2026 14:05 CDT". */
export function chicagoTimestamp(date: Date): string {
  const p = parts(date);
  const hour = p.hour === '24' ? '00' : p.hour;
  return `${p.month}/${p.day}/${p.year} ${hour}:${p.minute} ${p.timeZoneName}`;
}

/**
 * Days since an MM/DD (or M/D/YYYY) cell value, measured in Chicago dates.
 * A year-less date in the future is read as last year. Returns undefined if unparseable.
 */
export function daysSinceMonthDay(value: string, now: Date): number | undefined {
  const m = value.trim().match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (!m) return undefined;
  const p = parts(now);
  const todayYear = Number(p.year);
  const today = Date.UTC(todayYear, Number(p.month) - 1, Number(p.day));
  let year = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : todayYear;
  let then = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
  if (!m[3] && then > today) {
    year -= 1;
    then = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
  }
  return Math.round((today - then) / 86_400_000);
}
