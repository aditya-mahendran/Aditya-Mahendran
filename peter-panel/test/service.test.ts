import { describe, expect, it } from 'vitest';
import { rowVersion } from '../src/domain/rules.js';
import { PanelError } from '../src/service/errors.js';
import { UNDO_WINDOW_MS } from '../src/service/UndoRegistry.js';
import { NOW, setup, topic } from './helpers.js';

const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: PanelError) => e.code);

describe('identity and permissions', () => {
  it('rejects people not on Team, and writes nothing', async () => {
    const { service, store } = setup();
    await expect(service.identify('USTRANGER')).rejects.toMatchObject({
      code: 'NOT_ON_TEAM',
      message: "You're not on the programming team list — ask a programming lead.",
    });
    expect(store.log).toHaveLength(0);
    expect(store.tabs.size).toBe(0);
  });

  it('binds a Team row with no Slack ID by real name on first use', async () => {
    const { service, store } = setup();
    const alex = await service.identify('UALEX', { realName: 'alex  nobel' });
    expect(alex).toMatchObject({ slackId: 'UALEX', name: 'Alex Nobel' });
    expect(store.team.find((m) => m.name === 'Alex Nobel')?.slackId).toBe('UALEX');
    expect(await service.identify('UALEX')).toMatchObject({ name: 'Alex Nobel' });
  });

  it('says "Pick your topic first" before an owner picks', async () => {
    const { service, as } = setup();
    const keanan = await as('UKEANAN');
    expect(await code(service.addPanelist(keanan, { name: 'Joe J' }))).toBe('NO_TOPIC');
    expect(() => service.topicForWrite(keanan)).toThrow('Pick your topic first.');
  });

  it("stops an owner touching another topic's tab; an admin can", async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    await service.pick(await as('UGIA'), 'airtime');
    const keanan = await as('UKEANAN');
    expect(await code(service.addPanelist(keanan, { name: 'X' }, { topicId: 'airtime' }))).toBe('FORBIDDEN');
    expect(await code(service.listTopic(keanan, 'airtime'))).toBe('FORBIDDEN');
    const adi = await as('UADI');
    expect(await code(service.addPanelist(adi, { name: 'X' }, { topicId: 'airtime' }))).toBe('ok');
    expect((await service.listTopic(adi, 'airtime')).rows).toHaveLength(1);
  });

  it('keeps lead-only commands to admins', async () => {
    const { service, as } = setup();
    expect(() => service.requireAdmin({ slackId: 'U', name: 'x', role: 'owner', topic: '' })).toThrow(PanelError);
    expect(await code(service.assign(await as('UKEANAN'), 'UGIA', 'money'))).toBe('ADMIN_ONLY');
  });
});

describe('/panel pick (FR-0)', () => {
  it('creates the tab, writes Team, notifies, and hides the panel from others', async () => {
    const { service, store, notices, as } = setup();
    expect(await service.unclaimedTopics()).toHaveLength(15);
    const t = await service.pick(await as('UKEANAN'), 'money');
    expect(t.panel).toBe('Where the Money Blows');
    expect(store.tabs.has('Where the Money Blows')).toBe(true);
    expect(store.team.find((m) => m.slackId === 'UKEANAN')?.topic).toBe('Where the Money Blows');
    expect(notices).toEqual([':raised_hands: Keanan Crasto owns *Where the Money Blows*']);
    expect((await service.unclaimedTopics()).map((x) => x.id)).not.toContain('money');
  });

  it('refuses a second pick', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    expect(await code(service.pick(await as('UKEANAN'), 'grid'))).toBe('ALREADY_PICKED');
  });

  it('gives the slower of two simultaneous picks "Just taken"', async () => {
    const { service, as } = setup();
    const [a, b] = await Promise.allSettled([
      service.pick(await as('UKEANAN'), 'grid'),
      service.pick(await as('UGIA'), 'grid'),
    ]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'TAKEN', message: 'Just taken — pick another.' } });
  });

  it('lets an admin assign and reassign', async () => {
    const { service, store, as } = setup();
    const adi = await as('UADI');
    await service.pick(await as('UKEANAN'), 'money');
    const r = await service.assign(adi, 'UGIA', 'money');
    expect(r.previous?.name).toBe('Keanan Crasto');
    expect(store.team.find((m) => m.slackId === 'UKEANAN')?.topic).toBe('');
    expect(store.team.find((m) => m.slackId === 'UGIA')?.topic).toBe('Where the Money Blows');
  });

  it('resolves panels by number, alias or name', () => {
    const { service } = setup();
    expect(service.resolveTopic('5').id).toBe('grid');
    expect(service.resolveTopic('Headwinds for EVs?').id).toBe('evs');
    expect(service.resolveTopic('nuclear').id).toBe('nuclear');
    expect(() => service.resolveTopic('Basket weaving')).toThrow(PanelError);
  });
});

describe('/panel add (FR-1, FR-2, FR-4, FR-5, FR-10)', () => {
  async function owner() {
    const ctx = setup();
    await ctx.service.pick(await ctx.as('UKEANAN'), 'money');
    return { ...ctx, keanan: await ctx.as('UKEANAN') };
  }

  it('adds a name-only row with B = today, C = Potential Outreach, K = topic', async () => {
    const { service, store, keanan } = await owner();
    const r = await service.addPanelist(keanan, { name: '  Joe J ' });
    const [row] = store.tabs.get('Where the Money Blows')!;
    expect(row).toMatchObject({ name: 'Joe J', lastUpdated: '10/13', status: 'Potential Outreach', panelA: 'Where the Money Blows', confirmed: '' });
    expect(r.undoId).toBeTruthy();
  });

  it('mirrors the row into Panel Tracker', async () => {
    const { service, store, keanan } = await owner();
    await service.addPanelist(keanan, { name: 'Joe J', company: 'Acme' });
    expect(store.tracker).toHaveLength(1);
    expect(store.tracker[0]).toEqual(store.tabs.get('Where the Money Blows')![0]);
  });

  it('logs exactly one Update Log row per write', async () => {
    const { service, store, keanan } = await owner();
    const before = store.log.length;
    await service.addPanelist(keanan, { name: 'Joe J', company: 'Acme' });
    expect(store.log).toHaveLength(before + 1);
    expect(store.log.at(-1)).toMatchObject({
      timestamp: '10/13/2026 10:00 CDT',
      submittedBy: 'Keanan Crasto',
      panelistName: 'Joe J',
      fields: { name: 'Joe J', company: 'Acme', status: 'Potential Outreach' },
    });
  });

  it('writes notes as "MM/DD (Name): text"', async () => {
    const { service, store, keanan } = await owner();
    await service.addPanelist(keanan, { name: 'Joe J' } as never);
    await service.addPanelist(keanan, { name: 'Ann B', notes: 'Met at NYCW' } as never);
    expect(store.tabs.get('Where the Money Blows')![1]?.notes).toBe('10/13 (Keanan Crasto): Met at NYCW');
  });

  it('warns about a name already on another tab, and allows Add anyway', async () => {
    const { service, store, as, keanan } = await owner();
    await service.pick(await as('UGIA'), 'airtime');
    await service.addPanelist(await as('UGIA'), { name: 'Joe J', status: 'Interested' });
    const err = (await service.addPanelist(keanan, { name: 'joe  j' }).catch((e) => e)) as PanelError;
    expect(err.code).toBe('DUPLICATE');
    expect(err.data).toMatchObject({
      kind: 'duplicate',
      duplicates: { topicMatches: [{ topic: { id: 'airtime' }, owner: 'Gia Levatich', status: 'Interested' }] },
    });
    expect(store.tabs.get('Where the Money Blows')).toHaveLength(0);
    await service.addPanelist(keanan, { name: 'joe  j' }, { force: true });
    expect(store.tabs.get('Where the Money Blows')).toHaveLength(1);
  });

  it("flags last year's reference as context, without blocking", async () => {
    const { service, keanan } = await owner();
    const r = await service.addPanelist(keanan, { name: 'pat lastyear' });
    expect(r.reference).toEqual([{ name: 'Pat Lastyear', company: 'OldCo', status: 'Declined', notes: 'Said maybe next year', panel: 'Air Time' }]);
  });

  it('rejects dropdown values the workbook would not accept', async () => {
    const { service, store, keanan } = await owner();
    expect(await code(service.addPanelist(keanan, { name: 'Joe', status: 'Sort of' }))).toBe('VALIDATION');
    expect(store.tabs.get('Where the Money Blows')).toHaveLength(0);
  });

  it('creates the tab when an admin adds to a panel with no owner', async () => {
    const { service, store, as } = setup();
    await service.addPanelist(await as('UADI'), { name: 'Sam S' }, { topicId: 'sailing' });
    expect(store.tabs.get('Smoother Sailing')?.[0]?.name).toBe('Sam S');
  });

  it('sets D and posts one notification when added as Confirmed', async () => {
    const { service, store, notices, keanan } = await owner();
    notices.length = 0;
    await service.addPanelist(keanan, { name: 'Joe J', company: 'Acme', status: 'Confirmed' });
    expect(store.tabs.get('Where the Money Blows')![0]?.confirmed).toBe('YES 🥳');
    expect(notices).toEqual([':tada: *Joe J* (Acme) confirmed for *Where the Money Blows* — logged by Keanan Crasto']);
  });
});

describe('/panel update (FR-3, FR-4, FR-7, FR-10)', () => {
  async function withRow() {
    const ctx = setup();
    await ctx.service.pick(await ctx.as('UKEANAN'), 'money');
    const keanan = await ctx.as('UKEANAN');
    await ctx.service.addPanelist(keanan, { name: 'Joe J', company: 'Acme', status: 'Outreach 1 Sent' });
    const { version } = await ctx.service.getPanelist(keanan, undefined, 'joe j');
    ctx.notices.length = 0;
    return { ...ctx, keanan, version };
  }

  it('writes only changed cells, in both the topic tab and Panel Tracker', async () => {
    const { service, store, keanan, version } = await withRow();
    // Someone edits Location directly in Excel on both sheets.
    store.tabs.get('Where the Money Blows')![0]!.location = 'Chicago';
    store.tracker[0]!.location = 'Chicago';
    const { version: v2 } = await service.getPanelist(keanan, undefined, 'Joe J');
    expect(v2).not.toBe(version);
    const r = await service.updatePanelist(keanan, { name: 'Joe J', version: v2, changes: { status: 'Interested', company: 'Acme' } });
    expect(r.diff).toBe('Status: Outreach 1 Sent → Interested');
    const tabRow = store.tabs.get('Where the Money Blows')![0]!;
    expect(tabRow).toMatchObject({ status: 'Interested', location: 'Chicago', company: 'Acme' });
    expect(store.tracker[0]).toEqual(tabRow);
    expect(store.log.at(-1)).toMatchObject({ update: 'Status: Outreach 1 Sent → Interested', fields: { status: 'Interested' } });
    expect(store.log.at(-1)!.fields).not.toHaveProperty('company');
  });

  it('refuses a stale modal with the latest row', async () => {
    const { service, store, keanan, version } = await withRow();
    store.tabs.get('Where the Money Blows')![0]!.company = 'Edited in Excel';
    const err = (await service.updatePanelist(keanan, { name: 'Joe J', version, changes: { status: 'Interested' } }).catch((e) => e)) as PanelError;
    expect(err.code).toBe('CONFLICT');
    expect(err.message).toBe('This row changed — here’s the latest.');
    expect(err.data).toMatchObject({ kind: 'conflict', latest: { data: { company: 'Edited in Excel' } } });
  });

  it('appends notes without touching earlier ones', async () => {
    const { service, store, keanan, version, setClock } = await withRow();
    await service.updatePanelist(keanan, { name: 'Joe J', version, changes: {}, note: 'Sent deck' });
    setClock(() => new Date('2026-10-15T15:00:00Z'));
    const { version: v2 } = await service.getPanelist(keanan, undefined, 'Joe J');
    await service.updatePanelist(keanan, { name: 'Joe J', version: v2, changes: {}, note: 'Call booked' });
    expect(store.tabs.get('Where the Money Blows')![0]!.notes).toBe('10/13 (Keanan Crasto): Sent deck\n10/15 (Keanan Crasto): Call booked');
  });

  it('says so when nothing changed, and writes nothing', async () => {
    const { service, store, keanan, version } = await withRow();
    const logs = store.log.length;
    expect(await code(service.updatePanelist(keanan, { name: 'Joe J', version, changes: { company: 'Acme ' } }))).toBe('NO_CHANGES');
    expect(store.log).toHaveLength(logs);
  });

  it('Confirmed sets D and posts once; moving off clears D', async () => {
    const { service, store, notices, keanan, version } = await withRow();
    await service.updatePanelist(keanan, { name: 'Joe J', version, changes: { status: 'Confirmed' } });
    expect(store.tabs.get('Where the Money Blows')![0]!.confirmed).toBe('YES 🥳');
    expect(store.tracker[0]!.confirmed).toBe('YES 🥳');
    expect(notices).toHaveLength(1);
    const { version: v2 } = await service.getPanelist(keanan, undefined, 'Joe J');
    await service.updatePanelist(keanan, { name: 'Joe J', version: v2, changes: { company: 'Acme Inc' } });
    expect(notices).toHaveLength(1); // no repeat when status didn't change
    const { version: v3 } = await service.getPanelist(keanan, undefined, 'Joe J');
    await service.updatePanelist(keanan, { name: 'Joe J', version: v3, changes: { status: 'Declined' } });
    expect(store.tabs.get('Where the Money Blows')![0]!.confirmed).toBe('');
    expect(notices.at(-1)).toBe(':x: *Joe J* (Acme Inc) declined for *Where the Money Blows* — logged by Keanan Crasto');
  });

  it('renames in both places without duplicating the tracker row', async () => {
    const { service, store, keanan, version } = await withRow();
    await service.updatePanelist(keanan, { name: 'Joe J', version, changes: { name: 'Joe Johnson' } });
    expect(store.tracker.filter((r) => r?.name)).toHaveLength(1);
    expect(store.tracker[0]!.name).toBe('Joe Johnson');
  });
});

describe('undo (FR-6)', () => {
  async function withRow() {
    const ctx = setup();
    await ctx.service.pick(await ctx.as('UKEANAN'), 'money');
    const keanan = await ctx.as('UKEANAN');
    const add = await ctx.service.addPanelist(keanan, { name: 'Joe J', status: 'Outreach 1 Sent' });
    return { ...ctx, keanan, add };
  }

  it('restores previous values in the topic tab and Panel Tracker, and logs UNDO', async () => {
    const { service, store, keanan } = await withRow();
    const { version } = await service.getPanelist(keanan, undefined, 'Joe J');
    const upd = await service.updatePanelist(keanan, { name: 'Joe J', version, changes: { status: 'Interested', company: 'Acme' } });
    await service.undoWrite(keanan, upd.undoId);
    expect(store.tabs.get('Where the Money Blows')![0]).toMatchObject({ status: 'Outreach 1 Sent', company: '' });
    expect(store.tracker[0]).toMatchObject({ status: 'Outreach 1 Sent', company: '' });
    expect(store.log.at(-1)!.update).toBe('UNDO: Status: Outreach 1 Sent → Interested; Company: (blank) → Acme');
    expect(await code(service.undoWrite(keanan, upd.undoId))).toBe('UNDO_UNAVAILABLE');
  });

  it('removes an added row from both sheets', async () => {
    const { service, store, keanan, add } = await withRow();
    await service.undoWrite(keanan, add.undoId);
    expect(await store.listPanelists({ kind: 'topic', topic: (await service.listTopic(keanan)).topic })).toHaveLength(0);
    expect(await store.listPanelists({ kind: 'tracker' })).toHaveLength(0);
  });

  it('expires after 10 minutes', async () => {
    const { service, keanan, add, setClock } = await withRow();
    setClock(() => new Date(NOW.getTime() + UNDO_WINDOW_MS + 1));
    expect(await code(service.undoWrite(keanan, add.undoId))).toBe('UNDO_UNAVAILABLE');
  });

  it("refuses when the row changed since, so later edits aren't clobbered", async () => {
    const { service, store, keanan, add } = await withRow();
    store.tabs.get('Where the Money Blows')![0]!.company = 'Edited';
    expect(await code(service.undoWrite(keanan, add.undoId))).toBe('UNDO_UNAVAILABLE');
  });

  it("only lets the author (or an admin) undo", async () => {
    const { service, as, add } = await withRow();
    expect(await code(service.undoWrite(await as('UGIA'), add.undoId))).toBe('FORBIDDEN');
    expect(await code(service.undoWrite(await as('UADI'), add.undoId))).toBe('ok');
  });
});

describe('mirror failures and resync (FR-10)', () => {
  it('logs MIRROR FAILED and retries from the queue', async () => {
    const { service, store, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    store.failNextWrites = { sheet: 'tracker', count: 1 };
    await service.addPanelist(await as('UKEANAN'), { name: 'Joe J' });
    expect(store.log.some((l) => l.update.startsWith('MIRROR FAILED'))).toBe(true);
    await service.settle();
    expect(store.tracker.filter((r) => r?.name)).toHaveLength(1);
  });

  it('rebuilds Panel Tracker after direct Excel edits, without duplicating rows', async () => {
    const { service, store, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const keanan = await as('UKEANAN');
    await service.addPanelist(keanan, { name: 'Joe J' });
    await service.addPanelist(keanan, { name: 'Ann B' });
    const tab = store.tabs.get('Where the Money Blows')!;
    tab[0]!.status = 'Interested'; // edited in Excel
    tab.push({ ...tab[1]!, name: 'Typed In Excel', panelA: '' }); // added in Excel
    tab[1] = null; // Ann deleted in Excel
    store.tracker.push({ ...store.tracker[0]! }); // a stray duplicate
    const unrelated = { ...store.tracker[0]!, name: 'Manual Row', panelA: 'Some Old Panel' };
    store.tracker.push(unrelated);

    const stats = await service.resync('Adi Mahendran');
    const names = (await store.listPanelists({ kind: 'tracker' })).map((r) => r.data.name).sort();
    expect(names).toEqual(['Joe J', 'Manual Row', 'Typed In Excel']);
    expect(stats).toEqual({ added: 1, updated: 1, cleared: 2 });
    expect((await store.findByName({ kind: 'tracker' }, 'Joe J'))[0].data.status).toBe('Interested');
    expect((await service.resync()).added).toBe(0); // idempotent
  });
});

describe('reads', () => {
  it('/panel status counts per topic and lists who has not picked', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const k = await as('UKEANAN');
    await service.addPanelist(k, { name: 'A', status: 'Confirmed' });
    await service.addPanelist(k, { name: 'B', status: 'Outreach 2 Sent' });
    await service.addPanelist(k, { name: 'C' });
    const { topics, unpicked } = await service.status();
    expect(topics.find((t) => t.topic.id === 'money')).toMatchObject({
      owner: { name: 'Keanan Crasto' },
      counts: { Confirmed: 1, Interested: 0, 'In outreach': 1, 'Not started': 1, Closed: 0 },
    });
    expect(unpicked.map((m) => m.name)).toEqual(['Gia Levatich', 'Lauren Murphy', 'Alex Nobel']);
  });

  it('/panel find searches every tab and the reference', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    await service.addPanelist(await as('UKEANAN'), { name: 'Pat Newyear' });
    const r = await service.find('pat');
    expect(r.current.map((c) => c.row.name)).toEqual(['Pat Newyear']);
    expect(r.reference.map((c) => c.name)).toEqual(['Pat Lastyear']);
  });

  it('weekly reminders flag Outreach Sent rows untouched for 7+ days', async () => {
    const { service, store, as, setClock } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    await service.addPanelist(await as('UKEANAN'), { name: 'Old', status: 'Outreach 1 Sent' });
    await service.addPanelist(await as('UKEANAN'), { name: 'Fresh', status: 'Outreach 2 Sent' });
    store.tabs.get('Where the Money Blows')![1]!.lastUpdated = '10/19';
    setClock(() => new Date('2026-10-20T14:00:00Z'));
    const [digest] = await service.reminders();
    expect(digest.owner.name).toBe('Keanan Crasto');
    expect(digest.stale).toEqual([{ name: 'Old', status: 'Outreach 1 Sent', days: 7 }]);
  });

  it('version hashes are stable for the same row', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const r = await service.addPanelist(await as('UKEANAN'), { name: 'Joe' });
    expect((await service.getPanelist(await as('UKEANAN'), undefined, 'Joe')).version).toBe(rowVersion(r.panelist));
  });
});
