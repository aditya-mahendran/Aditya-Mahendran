/**
 * One-off, idempotent Google Sheet setup. Safe to re-run.
 *
 *   1. Checks the service account can open the sheet and the expected tabs exist.
 *   2. Hidden "Lists" tab with the 15 panel names; Panel Tracker's K and L dropdowns
 *      point at it.
 *   3. "Team" tab with the ten names from config/team.json. With SLACK_BOT_TOKEN set,
 *      Slack user IDs are filled in by looking each name up with users.list.
 *
 *   4. Panel tabs (planning layout): adds an "Outreach Status" column and a "Potential
 *      Panelists" list to each, and sets each owner's panel on the Team tab from the
 *      tab's Director/Owner cell, and copies people already listed on the tabs into
 *      Panel Tracker so Peter Panel recognises them.
 *
 * Options:
 *   --dry-run              print what would change, write nothing
 *   --clear-update-log     delete every Update Log row below the header (do once, before launch)
 *   --skip-slack-ids       don't look up Slack user IDs (people are matched by name on first use)
 *   --fix-reference-swap   in the 2025 reference tab, move a value from Connection to Location
 *                          where Location is empty (review the printed rows first with --dry-run)
 *
 *   npm run setup-sheet -- --dry-run
 */
import 'dotenv/config';
import { googleConfigFromEnv, loadTopics } from '../src/config.js';
import { googleTokenProvider, serviceAccountEmail } from '../src/store/sheets/googleAuth.js';
import { a1, SheetsStore } from '../src/store/sheets/SheetsStore.js';
import { listedPeople, personToRow, planTabSetup } from '../src/store/sheets/PlanningTabs.js';
import { chicagoMonthDay } from '../src/domain/time.js';
import { normalizeName } from '../src/domain/normalize.js';
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
  await write('POST', `/values/${encodeURIComponent(a1(SHEETS.lists, 'A1:A200'))}:clear`, {}, 'clear the old panel list');
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

/**
 * Planning-tab layout: on each panel tab, add an "Outreach Status" column to Potential
 * Moderators and a matching "Potential Panelists" list (formatted like the moderators list)
 * above the Activity checklist. Also collects each tab's Director/Owner for the Team tab.
 */
async function setupPanelTabs(titles: string[]): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  for (const topic of loadTopics()) {
    console.log(`• ${topic.number}. ${topic.tabName}`);
    if (!titles.includes(topic.tabName)) {
      console.log(`  ! No tab named exactly "${topic.tabName}" — rename the tab or fix config/topics.json.`);
      continue;
    }
    const sheet = (await store.sheet(topic.tabName))!;
    const plan = planTabSetup(await store.readGrid(topic.tabName));
    for (const p of plan.problems) console.log(`  ! ${p}`);
    if (plan.owner) owners.set(topic.panel, plan.owner);
    for (const h of plan.headerCells) {
      await setValues(a1(topic.tabName, `${columnLetter(h.col + 1)}${h.row}`), [[h.value]], `add "${h.value}" column header`);
      await batch(
        [{ copyPaste: { source: cellRange(sheet.sheetId, h.row, h.col - 1), destination: cellRange(sheet.sheetId, h.row, h.col), pasteType: 'PASTE_FORMAT' } }],
        'format it like the Notes header',
      );
    }
    if (plan.panelists) {
      const { at, count, values, formatRows } = plan.panelists;
      await batch(
        [{ insertDimension: { range: { sheetId: sheet.sheetId, dimension: 'ROWS', startIndex: at - 1, endIndex: at - 1 + count }, inheritFromBefore: true } }],
        `insert ${count} rows at row ${at} for a "Potential Panelists" list`,
      );
      await write(
        'POST',
        '/values:batchUpdate',
        { valueInputOption: 'RAW', data: values.map((v) => ({ range: a1(topic.tabName, `${columnLetter(v.col + 1)}${v.row}`), values: [[v.value]] })) },
        'write its title and headers',
      );
      await batch(
        formatRows.map(([from, to]) => ({ copyPaste: { source: rowRange(sheet.sheetId, from), destination: rowRange(sheet.sheetId, to), pasteType: 'PASTE_FORMAT' } })),
        'format it like Potential Moderators',
      );
    } else {
      console.log('  Potential Panelists list already there');
    }
    console.log(`  Owner: ${plan.owner ?? '(none on the tab)'}`);
  }
  return owners;
}

const cellRange = (sheetId: number, row: number, col: number) => ({ sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: col, endColumnIndex: col + 1 });
const rowRange = (sheetId: number, row: number) => ({ sheetId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 26 });

/**
 * Copies the people already typed into each panel tab's lists into Panel Tracker (once), so
 * Peter Panel recognises them by name. People already in Panel Tracker for that panel are skipped.
 */
async function importListedPeople(titles: string[]) {
  console.log('• People already on the panel tabs → Panel Tracker');
  const tracker = await store.listPanelists({ kind: 'tracker' });
  const have = new Set(tracker.map((r) => `${normalizeName(r.data.name)}|${normalizeName(r.data.panelA)}`));
  const today = chicagoMonthDay(new Date());
  let added = 0;
  for (const topic of loadTopics()) {
    if (!titles.includes(topic.tabName)) continue;
    for (const person of listedPeople(await store.readGrid(topic.tabName))) {
      const key = `${normalizeName(person.name)}|${normalizeName(topic.panel)}`;
      if (have.has(key)) continue;
      have.add(key);
      added++;
      console.log(`  ${dryRun ? '[dry-run] ' : ''}${topic.tabName}: ${person.name} (${person.kind})`);
      if (!dryRun) await store.addPanelist({ kind: 'tracker' }, personToRow(person, topic.panel, today));
    }
  }
  console.log(`  ${added} ${dryRun ? 'would be' : ''} added`);
}

/** Sets each owner's Topic on the Team tab from the panel tabs' Director/Owner cells. */
async function assignOwners(owners: Map<string, string>) {
  console.log('• Panel owners → Team tab');
  const values = await store.getValues(a1(SHEETS.team, 'A1:D'));
  const data: { range: string; values: string[][] }[] = [];
  for (const [panel, owner] of owners) {
    const i = values.findIndex((r, idx) => idx > 0 && normalizeName(String(r[1] ?? '')) === normalizeName(owner));
    if (i < 0) {
      console.log(`  ! ${owner} (owner of ${panel}) isn't on the Team tab — add them, then re-run.`);
      continue;
    }
    if (String(values[i][3] ?? '').trim() === panel) continue;
    console.log(`  ${owner} → ${panel}`);
    data.push({ range: a1(SHEETS.team, `D${i + 1}`), values: [[panel]] });
  }
  if (data.length) await write('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data }, `set ${data.length} panel owners`);
  else console.log('  already up to date');
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
  if (process.env.TAB_LAYOUT !== 'rows') {
    const owners = await setupPanelTabs(titles);
    if (!dryRun) await store.sheets(true);
    await assignOwners(owners);
    await importListedPeople(titles);
  }
  if (args.has('--clear-update-log')) await clearUpdateLog();
  if (args.has('--fix-reference-swap')) await fixReferenceSwap();
  console.log('\nDone. Set STORE=sheets in .env and restart the app (or /panel reload if it is already on sheets).');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
