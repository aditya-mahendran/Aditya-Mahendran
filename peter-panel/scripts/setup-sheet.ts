/**
 * One-off, idempotent Google Sheet setup. Safe to re-run.
 *
 *   1. Checks the service account can open the sheet and the expected tabs exist.
 *   2. Hidden "Lists" tab with the 15 panel names; Panel Tracker's K and L dropdowns
 *      point at it.
 *   3. "Team" tab with the ten names from config/team.json. With SLACK_BOT_TOKEN set,
 *      Slack user IDs are filled in by looking each name up with users.list.
 *
 * Topic tabs are NOT created here — /panel pick and /panel assign make them.
 *
 * Options:
 *   --dry-run              print what would change, write nothing
 *   --clear-update-log     delete every Update Log row below the header (do once, before launch)
 *   --fix-reference-swap   in the 2025 reference tab, move a value from Connection to Location
 *                          where Location is empty (review the printed rows first with --dry-run)
 *
 *   npm run setup-sheet -- --dry-run
 */
import 'dotenv/config';
import { googleConfigFromEnv, loadTopics } from '../src/config.js';
import { googleTokenProvider, serviceAccountEmail } from '../src/store/sheets/googleAuth.js';
import { a1, SheetsStore } from '../src/store/sheets/SheetsStore.js';
import { SHEETS, columnLetter, headerToField } from '../src/store/graph/GraphStore.js';
import { mergeTeam, TEAM_HEADER } from './lib/team.js';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const cfg = googleConfigFromEnv();
const email = serviceAccountEmail(cfg);
const store = new SheetsStore(SheetsStore.client(googleTokenProvider(cfg)), cfg.sheetId, loadTopics());
const api = SheetsStore.client(googleTokenProvider(cfg));

async function write(method: string, path: string, body: unknown, what: string) {
  console.log(`  ${dryRun ? '[dry-run] ' : ''}${what}`);
  if (!dryRun) await api.request(method, `/${cfg.sheetId}${path}`, body);
}

const setValues = (range: string, values: string[][], what: string) =>
  write('PUT', `/values/${encodeURIComponent(range)}?valueInputOption=RAW`, { values }, what);

const batch = (requests: unknown[], what: string) => write('POST', ':batchUpdate', { requests }, what);

async function setupLists() {
  const panels = loadTopics().map((t) => t.panel);
  console.log(`• Lists tab (${panels.length} panels)`);
  if (!(await store.sheet(SHEETS.lists))) {
    await batch([{ addSheet: { properties: { title: SHEETS.lists, hidden: true } } }], `create hidden "${SHEETS.lists}" tab`);
  }
  if (!dryRun) await store.sheets(true);
  await setValues(a1(SHEETS.lists, `A1:A${panels.length}`), panels.map((p) => [p]), `write ${panels.length} panel names`);
  const lists = await store.sheet(SHEETS.lists);
  if (lists && !lists.hidden) await batch([{ updateSheetProperties: { properties: { sheetId: lists.sheetId, hidden: true }, fields: 'hidden' } }], 'hide Lists tab');

  const tracker = (await store.sheet(SHEETS.tracker))!;
  const rows = tracker.gridProperties?.rowCount ?? 300;
  const source = `=${a1(SHEETS.lists, `$A$1:$A$${panels.length}`)}`;
  await batch(
    [10, 11].map((col) => ({
      setDataValidation: {
        range: { sheetId: tracker.sheetId, startRowIndex: 1, endRowIndex: rows, startColumnIndex: col, endColumnIndex: col + 1 },
        rule: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: source }] }, showCustomUi: true, strict: true },
      },
    })),
    `point ${SHEETS.tracker} K2:L${rows} dropdowns at ${source}`,
  );
}

async function setupTeam() {
  console.log('• Team tab');
  if (!(await store.sheet(SHEETS.team))) {
    await batch([{ addSheet: { properties: { title: SHEETS.team, gridProperties: { frozenRowCount: 1 } } } }], 'create "Team" tab');
  }
  const existing = (await store.sheet(SHEETS.team)) ? await store.getValues(a1(SHEETS.team, 'A1:D')) : [];
  const rows = await mergeTeam(existing.slice(1));
  await setValues(a1(SHEETS.team, `A1:D${rows.length + 1}`), [TEAM_HEADER, ...rows], `write ${rows.length} people, ${rows.filter((r) => r[0]).length} with Slack IDs`);
}

async function clearUpdateLog() {
  const values = await store.getValues(a1(SHEETS.log, 'A1:Z'));
  if (values.length <= 1) return console.log('• Update Log already empty');
  const lastCol = columnLetter(Math.max(values[0]?.length ?? 4, 4));
  console.log('• Update Log');
  await write('POST', `/values/${encodeURIComponent(a1(SHEETS.log, `A2:${lastCol}${values.length}`))}:clear`, {}, `clear rows 2–${values.length}`);
}

async function fixReferenceSwap() {
  console.log('• Reference tab Connection → Location');
  const [header = [], ...rows] = await store.getValues(a1(SHEETS.reference, 'A1:Z'));
  const fields = header.map(headerToField);
  const loc = fields.indexOf('location');
  const conn = fields.indexOf('connection');
  const name = fields.indexOf('name');
  if (loc < 0 || conn < 0) throw new Error('Reference tab needs Location and Connection headers');
  const data: { range: string; values: string[][] }[] = [];
  for (const [i, r] of rows.entries()) {
    if (r[loc]?.trim() || !r[conn]?.trim()) continue;
    const row = i + 2;
    console.log(`  row ${row} ${r[name] ?? ''}: "${r[conn]}"`);
    data.push({ range: a1(SHEETS.reference, `${columnLetter(loc + 1)}${row}`), values: [[r[conn]]] });
    data.push({ range: a1(SHEETS.reference, `${columnLetter(conn + 1)}${row}`), values: [['']] });
  }
  if (data.length) await write('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data }, `move ${data.length / 2} values`);
}

async function main() {
  console.log(`${dryRun ? 'Dry run — nothing will be written.\n' : ''}Service account: ${email}\n`);
  let titles: string[];
  try {
    titles = (await store.sheets(true)).map((s) => s.title);
  } catch (err) {
    throw new Error(`Can't open the sheet. Share it with ${email} as an Editor and check GOOGLE_SHEET_ID.\n${(err as Error).message}`);
  }
  console.log(`Tabs: ${titles.join(', ')}\n`);
  for (const required of [SHEETS.tracker, SHEETS.log]) {
    if (!titles.includes(required)) throw new Error(`Tab "${required}" not found. Rename it to exactly "${required}" and re-run.`);
  }
  if (!titles.includes(SHEETS.reference)) console.log(`  ! No "${SHEETS.reference}" tab — duplicate checks won't include last year.\n`);

  await setupLists();
  await setupTeam();
  if (args.has('--clear-update-log')) await clearUpdateLog();
  if (args.has('--fix-reference-swap')) await fixReferenceSwap();
  console.log('\nDone. Set STORE=sheets in .env and restart the app (or /panel reload if it is already on sheets).');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
