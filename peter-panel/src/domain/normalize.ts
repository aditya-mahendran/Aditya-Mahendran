/** Case- and whitespace-insensitive key used to match names. */
export function normalizeName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function sameName(a: string, b: string): boolean {
  return normalizeName(a) === normalizeName(b);
}

/** Compares cell values the way a person would: ignoring surrounding whitespace. */
export function sameValue(a: string | undefined, b: string | undefined): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}
