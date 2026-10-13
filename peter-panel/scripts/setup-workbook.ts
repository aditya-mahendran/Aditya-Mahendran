/**
 * One-off, idempotent workbook setup. Safe to re-run.
 *
 *   1. Hidden "Lists" tab with the 15 panel names; Panel Tracker's K and L dropdowns
 *      point at it (the names are too long for an inline list).
 *   2. Panel Tracker converted to the table tbl_PanelTracker.
 *   3. "Team" tab with the ten names from config/team.json. With SLACK_BOT_TOKEN set,
 *      Slack user IDs are filled in by looking each name up with users.list.
 *
 * Topic tabs are NOT created here — /panel pick makes them.
 *
 * Options:
 *   --dry-run              print what would change, write nothing
 *   --clear-update-log     delete every Update Log row below the header (do once, before launch)
 *   --fix-reference-swap   in the 2025 reference tab, move a value from Connection to Location
 *                          where Location is empty (review the printed rows first with --dry-run)
 *
 *   npm run setup-workbook -- --dry-run
 */
import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import { graphConfigFromEnv, loadTeamSeed, loadTopics } from '../src/config.js';
import { normalizeName } from '../src/domain/normalize.js';
import { GraphClient, tokenProviderFromConfig } from '../src/store/graph/GraphClient.js';
import { GraphStore, SHEETS, columnLetter, headerToField, parseAddress } from '../src/store/graph/GraphStore.js';

const TRACKER_ROWS = 300;
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');

const cfg = graphConfigFromEnv();
const graph = new GraphClient(tokenProviderFromConfig(cfg));
const wb = GraphStore.workbookPath(cfg.siteId, cfg.driveId, cfg.itemId);
const sheet = (name: string) => `${wb}/worksheets/${encodeURIComponent(name)}`;
const range = (name: string, address: string) => `${sheet(name)}/range(address='${encodeURIComponent(address)}')`;

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  if (dryRun && method !== 'GET') {
    console.log(`  [dry-run] ${method} ${decodeURIComponent(path.replace(wb, ''))}`);
    return {} as T;
  }
  return graph.request<T>(method, path, body);
}

async function worksheetNames(): Promise<Set<string>> {
  const res = await graph.request<{ value: { name: string }[] }>('GET', `${wb}/worksheets?$select=name`);
  return new Set(res.value.map((w) => w.name));
}

async function usedRange(name: string) {
  return graph.request<{ address: string; text: string[][] }>('GET', `${sheet(name)}/usedRange(valuesOnly=true)?$select=address,text`);
}

async function setupLists(names: Set<string>) {
  const panels = loadTopics().map((t) => t.panel);
  console.log(`• Lists tab (${panels.length} panels)`);
  if (!names.has(SHEETS.lists)) await call('POST', `${wb}/worksheets/add`, { name: SHEETS.lists });
  await call('PATCH', range(SHEETS.lists, `A1:A${panels.length}`), { values: panels.map((p) => [p]) });
  await call('PATCH', sheet(SHEETS.lists), { visibility: 'Hidden' });

  const source = `=${SHEETS.lists}!$A$1:$A$${panels.length}`;
  for (const col of ['K', 'L']) {
    const target = `${col}2:${col}${TRACKER_ROWS}`;
    console.log(`  ${SHEETS.tracker}!${target} → ${source}`);
    await call('POST', `${range(SHEETS.tracker, target)}/dataValidation/clear`, {});
    await call('PATCH', `${range(SHEETS.tracker, target)}/dataValidation`, {
      rule: { list: { inCellDropDown: true, source } },
    });
  }
}

async function setupTrackerTable() {
  const tables = await graph.request<{ value: { id: string; name: string }[] }>('GET', `${sheet(SHEETS.tracker)}/tables?$select=id,name`);
  const existing = tables.value[0];
  if (existing?.name === SHEETS.trackerTable) {
    console.log(`• ${SHEETS.trackerTable} already exists`);
    return;
  }
  if (existing) {
    console.log(`• Renaming table ${existing.name} → ${SHEETS.trackerTable}`);
    await call('PATCH', `${wb}/tables/${encodeURIComponent(existing.id)}`, { name: SHEETS.trackerTable });
    return;
  }
  console.log(`• Converting ${SHEETS.tracker}!A1:O${TRACKER_ROWS} to ${SHEETS.trackerTable}`);
  const t = await call<{ id: string }>('POST', `${sheet(SHEETS.tracker)}/tables/add`, { address: `A1:O${TRACKER_ROWS}`, hasHeaders: true });
  if (t.id) await call('PATCH', `${wb}/tables/${encodeURIComponent(t.id)}`, { name: SHEETS.trackerTable });
}

async function slackIdsByName(): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (!process.env.SLACK_BOT_TOKEN) return ids;
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  for await (const page of slack.paginate('users.list', { limit: 200 })) {
    for (const u of (page as { members?: { id: string; deleted?: boolean; is_bot?: boolean; real_name?: string; profile?: { real_name?: string; display_name?: string } }[] }).members ?? []) {
      if (u.deleted || u.is_bot) continue;
      for (const n of [u.real_name, u.profile?.real_name, u.profile?.display_name]) if (n?.trim()) ids.set(normalizeName(n), u.id);
    }
  }
  return ids;
}

async function setupTeam(names: Set<string>) {
  console.log('• Team tab');
  if (!names.has(SHEETS.team)) await call('POST', `${wb}/worksheets/add`, { name: SHEETS.team });
  const existing = names.has(SHEETS.team) ? (await usedRange(SHEETS.team)).text : [];
  const header = ['Slack User ID', 'Name', 'Role', 'Topic'];
  const rows = existing.length > 1 ? existing.slice(1).map((r) => [...r]) : [];
  const ids = await slackIdsByName();
  for (const seed of loadTeamSeed()) {
    let row = rows.find((r) => normalizeName(r[1] ?? '') === normalizeName(seed.name));
    if (!row) rows.push((row = ['', seed.name, seed.role, '']));
    if (!row[0]) {
      const id = ids.get(normalizeName(seed.name));
      if (id) row[0] = id;
      else console.log(`  ! No Slack user found for ${seed.name}; they'll be matched by name on first use.`);
    }
  }
  await call('PATCH', range(SHEETS.team, `A1:D${rows.length + 1}`), { values: [header, ...rows.map((r) => r.slice(0, 4))] });
  await call('PATCH', `${range(SHEETS.team, 'A1:D1')}/format/font`, { bold: true });
  console.log(`  ${rows.length} people, ${rows.filter((r) => r[0]).length} with Slack IDs`);
}

async function clearUpdateLog() {
  const used = await usedRange(SHEETS.log);
  const { startRow, endRow } = parseAddress(used.address);
  if (endRow <= startRow) return console.log('• Update Log already empty');
  const lastCol = columnLetter(Math.max(used.text[0]?.length ?? 4, 4));
  console.log(`• Clearing Update Log rows ${startRow + 1}–${endRow}`);
  await call('POST', `${range(SHEETS.log, `A${startRow + 1}:${lastCol}${endRow}`)}/clear`, { applyTo: 'Contents' });
}

async function fixReferenceSwap() {
  const used = await usedRange(SHEETS.reference);
  const { startRow } = parseAddress(used.address);
  const [header = [], ...rows] = used.text;
  const fields = header.map(headerToField);
  const loc = fields.indexOf('location');
  const conn = fields.indexOf('connection');
  if (loc < 0 || conn < 0) throw new Error('Reference tab needs Location and Connection headers');
  const name = fields.indexOf('name');
  let n = 0;
  for (const [i, r] of rows.entries()) {
    if (r[loc]?.trim() || !r[conn]?.trim()) continue;
    const row = startRow + 1 + i;
    console.log(`  row ${row} ${r[name] ?? ''}: Connection "${r[conn]}" → Location`);
    await call('PATCH', range(SHEETS.reference, `${columnLetter(loc + 1)}${row}`), { values: [[r[conn]]] });
    await call('PATCH', range(SHEETS.reference, `${columnLetter(conn + 1)}${row}`), { values: [['']] });
    n++;
  }
  console.log(`• Reference swap: ${n} rows ${dryRun ? 'would be' : ''} fixed`);
}

async function main() {
  console.log(dryRun ? 'Dry run — nothing will be written.\n' : '');
  const names = await worksheetNames();
  for (const required of [SHEETS.tracker, SHEETS.log]) {
    if (!names.has(required)) throw new Error(`Worksheet "${required}" not found. Is SP_ITEM_ID the right file?`);
  }
  await setupLists(names);
  await setupTrackerTable();
  await setupTeam(names);
  if (args.has('--clear-update-log')) await clearUpdateLog();
  if (args.has('--fix-reference-swap')) await fixReferenceSwap();
  console.log('\nDone. Run /panel reload in Slack if the app is already running.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
