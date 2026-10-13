import { normalizeName, sameName, sameValue } from '../domain/normalize.js';
import {
  appendNote,
  applyAutoFields,
  changedFields,
  diffLine,
  isDeclined,
  rowVersion,
  statusBucket,
  STATUS_BUCKETS,
  DEFAULT_STATUS,
  CONFIRMED_STATUS,
  validatePanelist,
  type StatusBucket,
  type ValidationErrors,
} from '../domain/rules.js';
import { chicagoTimestamp, daysSinceMonthDay } from '../domain/time.js';
import {
  emptyPanelist,
  FIELD_LABELS,
  USER_FIELDS,
  type DropdownLists,
  type FieldKey,
  type Panelist,
  type PanelistRow,
  type SheetRef,
  type TeamMember,
  type Topic,
} from '../domain/types.js';
import { errorFields, logger } from '../logger.js';
import type { TrackerStore } from '../store/TrackerStore.js';
import { PanelError, type Duplicates } from './errors.js';
import { UndoRegistry } from './UndoRegistry.js';
import { WriteQueue } from './WriteQueue.js';

export interface Notifier {
  /** Posts one line to the notify channel. Must not throw. */
  notify(text: string): Promise<void>;
}

/** Who is calling, as Slack reports it; used to bind Team rows that have no Slack ID yet. */
export interface SlackProfile {
  realName?: string;
  displayName?: string;
}

export type UserInput = Partial<Pick<Panelist, (typeof USER_FIELDS)[number]>>;

export interface WriteResult {
  topic: Topic;
  panelist: Panelist;
  diff: string;
  undoId: string;
  /** Last year's reference matches, shown as context after an add. */
  reference?: Duplicates['reference'];
}

export interface TopicStatus {
  topic: Topic;
  owner?: TeamMember;
  hasTab: boolean;
  counts: Record<StatusBucket, number>;
  total: number;
}

export interface ReminderDigest {
  owner: TeamMember;
  topic: Topic;
  counts: Record<StatusBucket, number>;
  stale: { name: string; status: string; days: number }[];
}

export interface ServiceOptions {
  now?: () => Date;
  notifier?: Notifier;
  teamTtlMs?: number;
  mirrorRetryDelayMs?: number;
  mirrorRetries?: number;
  /** Seeds an admin binding for local development. */
  devAdminSlackId?: string;
}

const TEAM_TTL_MS = 5 * 60 * 1000;
const STALE_DAYS = 7;
const STALE_STATUSES = ['outreach 1 sent', 'outreach 2 sent'];

type MirrorOp =
  | { kind: 'upsert'; topic: Topic; before: Panelist | null; after: Panelist; fields: FieldKey[] }
  | { kind: 'clear'; topic: Topic; name: string };

const TRACKER: SheetRef = { kind: 'tracker' };
const tab = (topic: Topic): SheetRef => ({ kind: 'topic', topic });

/**
 * Everything the Slack layer can ask for. Slack-agnostic so it is fully unit-tested
 * against the in-memory store. All writes go through one queue.
 */
export class PanelService {
  readonly queue = new WriteQueue();
  readonly undo: UndoRegistry;
  private readonly now: () => Date;
  private readonly notifier: Notifier;
  private readonly teamTtlMs: number;
  private readonly mirrorRetryDelayMs: number;
  private readonly mirrorRetries: number;
  private team: { at: number; members: TeamMember[] } | null = null;
  private lists: DropdownLists | null = null;
  private readonly retries = new Set<Promise<void>>();

  constructor(
    private readonly store: TrackerStore,
    readonly topics: Topic[],
    opts: ServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.notifier = opts.notifier ?? { notify: async () => {} };
    this.teamTtlMs = opts.teamTtlMs ?? TEAM_TTL_MS;
    this.mirrorRetryDelayMs = opts.mirrorRetryDelayMs ?? 30_000;
    this.mirrorRetries = opts.mirrorRetries ?? 3;
    this.undo = new UndoRegistry(() => this.now().getTime());
  }

  // ---------------------------------------------------------------- config

  /** /panel reload: drops cached Team and dropdown lists. */
  async reload(): Promise<{ team: number; lists: DropdownLists }> {
    this.team = null;
    this.lists = null;
    const [team, lists] = await Promise.all([this.getTeam(), this.getLists()]);
    return { team: team.length, lists };
  }

  async getLists(): Promise<DropdownLists> {
    if (!this.lists) this.lists = await this.store.readLists();
    return this.lists;
  }

  async getTeam(force = false): Promise<TeamMember[]> {
    const t = this.now().getTime();
    if (force || !this.team || t - this.team.at > this.teamTtlMs) {
      this.team = { at: t, members: await this.store.readTeam() };
    }
    return this.team.members;
  }

  topicById(id: string): Topic {
    const topic = this.topics.find((t) => t.id === id);
    if (!topic) throw new PanelError('UNKNOWN_TOPIC');
    return topic;
  }

  topicByPanel(panel: string): Topic | undefined {
    return this.topics.find((t) => sameName(t.panel, panel) || sameName(t.tabName, panel));
  }

  /** Resolves free text from a slash command: number, id, alias, panel or tab name. */
  resolveTopic(text: string): Topic {
    const q = normalizeName(text.replace(/^["“]|["”]$/g, '')).replace(/\?$/, '');
    if (!q) throw new PanelError('UNKNOWN_TOPIC');
    const strip = (s: string) => normalizeName(s).replace(/\?$/, '');
    const exact = this.topics.find(
      (t) => String(t.number) === q || t.id === q || strip(t.alias) === q || strip(t.panel) === q || strip(t.tabName) === q,
    );
    if (exact) return exact;
    const partial = this.topics.filter((t) => strip(t.panel).includes(q) || strip(t.alias).includes(q));
    if (partial.length === 1) return partial[0];
    throw new PanelError('UNKNOWN_TOPIC', `I don't recognise the panel "${text}". Try its number (1–15) or name.`);
  }

  ownerOf(topic: Topic, team: TeamMember[]): TeamMember | undefined {
    return team.find((m) => m.role === 'owner' && sameName(m.topic, topic.panel));
  }

  // ---------------------------------------------------------------- identity

  /**
   * Looks the caller up in Team by Slack ID. A Team row with a matching name and
   * no Slack ID yet is bound to the caller on first use.
   */
  async identify(slackId: string, profile?: SlackProfile): Promise<TeamMember> {
    const team = await this.getTeam();
    const found = team.find((m) => m.slackId === slackId);
    if (found) return found;
    const names = [profile?.realName, profile?.displayName].filter((n): n is string => !!n?.trim());
    const unbound = team.find((m) => !m.slackId && names.some((n) => sameName(n, m.name)));
    if (!unbound) throw new PanelError('NOT_ON_TEAM');
    const bound = { ...unbound, slackId };
    await this.queue.run(() => this.store.writeTeamMember(bound));
    this.team = null;
    logger.info('team.bound', { name: bound.name });
    return bound;
  }

  /** Topics this person may read and write. */
  async topicsFor(actor: TeamMember): Promise<Topic[]> {
    if (actor.role === 'admin') return this.topics;
    const t = actor.topic ? this.topicByPanel(actor.topic) : undefined;
    return t ? [t] : [];
  }

  /** Enforces: owners work only on their own topic; admins on any. */
  topicForWrite(actor: TeamMember, topicId?: string): Topic {
    if (actor.role === 'admin') {
      if (!topicId) throw new PanelError('UNKNOWN_TOPIC', 'Choose a panel.');
      return this.topicById(topicId);
    }
    const own = actor.topic ? this.topicByPanel(actor.topic) : undefined;
    if (!own) throw new PanelError('NO_TOPIC');
    if (topicId && topicId !== own.id) throw new PanelError('FORBIDDEN');
    return own;
  }

  requireAdmin(actor: TeamMember) {
    if (actor.role !== 'admin') throw new PanelError('ADMIN_ONLY');
  }

  // ---------------------------------------------------------------- picking

  async unclaimedTopics(): Promise<Topic[]> {
    const team = await this.getTeam();
    return this.topics.filter((t) => !this.ownerOf(t, team));
  }

  /** FR-0: an owner claims an unclaimed panel; its tab is created if needed. */
  async pick(actor: TeamMember, topicId: string): Promise<Topic> {
    const topic = this.topicById(topicId);
    if (actor.role === 'admin') throw new PanelError('ADMIN_ONLY', 'Leads work across every panel — use /panel assign to give one to an owner.');
    return this.queue.run(async () => {
      const team = await this.getTeam(true);
      const me = team.find((m) => m.slackId === actor.slackId) ?? actor;
      if (me.topic) throw new PanelError('ALREADY_PICKED');
      if (this.ownerOf(topic, team)) throw new PanelError('TAKEN');
      await this.createTopicTab(topic);
      await this.store.writeTeamMember({ ...me, topic: topic.panel });
      this.team = null;
      await this.store.appendLog(this.logEntry(me.name, '', `PICK: ${me.name} → ${topic.panel}`));
      await this.notifier.notify(`:raised_hands: ${me.name} owns *${topic.panel}*`);
      return topic;
    });
  }

  /** /panel assign: an admin sets or changes someone's topic. */
  async assign(admin: TeamMember, targetSlackId: string, topicId: string, profile?: SlackProfile) {
    this.requireAdmin(admin);
    const topic = this.topicById(topicId);
    const target = await this.identify(targetSlackId, profile);
    if (target.role === 'admin') throw new PanelError('ADMIN_ONLY', `${target.name} is a lead and already covers every panel.`);
    return this.queue.run(async () => {
      const team = await this.getTeam(true);
      const previous = this.ownerOf(topic, team);
      if (previous && previous.slackId !== target.slackId) {
        await this.store.writeTeamMember({ ...previous, topic: '' });
      }
      await this.createTopicTab(topic);
      await this.store.writeTeamMember({ ...target, topic: topic.panel });
      this.team = null;
      await this.store.appendLog(this.logEntry(admin.name, '', `ASSIGN: ${target.name} → ${topic.panel}`));
      await this.notifier.notify(`:raised_hands: ${target.name} owns *${topic.panel}* (assigned by ${admin.name})`);
      return { topic, target, previous: previous && previous.slackId !== target.slackId ? previous : undefined };
    });
  }

  /** The one shared tab-creation path, used by pick, assign and admin add. */
  private async createTopicTab(topic: Topic) {
    if (!(await this.store.hasTopicTab(topic))) {
      await this.store.createTopicTab(topic);
      logger.info('tab.created', { tab: topic.tabName });
    }
  }

  // ---------------------------------------------------------------- reads

  async listTopic(actor: TeamMember, topicId?: string): Promise<{ topic: Topic; rows: PanelistRow[] }> {
    const topic = this.topicForWrite(actor, topicId);
    if (!(await this.store.hasTopicTab(topic))) return { topic, rows: [] };
    return { topic, rows: await this.store.listPanelists(tab(topic)) };
  }

  async getPanelist(actor: TeamMember, topicId: string | undefined, name: string) {
    const topic = this.topicForWrite(actor, topicId);
    const [row] = (await this.store.hasTopicTab(topic)) ? await this.store.findByName(tab(topic), name) : [];
    if (!row) throw new PanelError('NOT_FOUND', `I couldn't find "${name}" on ${topic.tabName}.`);
    return { topic, row, version: rowVersion(row.data) };
  }

  /** Names for the Update modal's searchable select. Owners see only their tab. */
  async searchNames(actor: TeamMember, query: string, limit = 100) {
    const q = normalizeName(query);
    const out: { topic: Topic; name: string; status: string }[] = [];
    for (const topic of await this.topicsFor(actor)) {
      if (!(await this.store.hasTopicTab(topic))) continue;
      for (const r of await this.store.listPanelists(tab(topic))) {
        if (!q || normalizeName(r.data.name).includes(q)) out.push({ topic, name: r.data.name, status: r.data.status });
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  }

  /** FR-2: same name on any topic tab, plus last year's reference as context. */
  async findDuplicates(name: string): Promise<Duplicates> {
    const team = await this.getTeam();
    const topicMatches: Duplicates['topicMatches'] = [];
    for (const topic of this.topics) {
      if (!(await this.store.hasTopicTab(topic))) continue;
      for (const r of await this.store.findByName(tab(topic), name)) {
        topicMatches.push({ topic, owner: this.ownerOf(topic, team)?.name ?? 'no owner yet', status: r.data.status });
      }
    }
    const reference = (await this.store.listReference())
      .filter((r) => sameName(r.name, name))
      .map((r) => ({ name: r.name, company: r.company, status: r.status, notes: r.notes, panel: r.panelA }));
    return { topicMatches, reference };
  }

  /** /panel find: substring search across every topic tab and last year's reference. */
  async find(query: string) {
    const q = normalizeName(query);
    if (!q) return { current: [], reference: [] };
    const team = await this.getTeam();
    const current: { topic: Topic; owner: string; row: Panelist }[] = [];
    for (const topic of this.topics) {
      if (!(await this.store.hasTopicTab(topic))) continue;
      for (const r of await this.store.listPanelists(tab(topic))) {
        if (normalizeName(r.data.name).includes(q)) {
          current.push({ topic, owner: this.ownerOf(topic, team)?.name ?? 'no owner yet', row: r.data });
        }
      }
    }
    const reference = (await this.store.listReference()).filter((r) => normalizeName(r.name).includes(q));
    return { current, reference };
  }

  /** /panel status: per-topic bucket counts, plus owners who haven't picked. */
  async status(): Promise<{ topics: TopicStatus[]; unpicked: TeamMember[] }> {
    const team = await this.getTeam();
    const topics: TopicStatus[] = [];
    for (const topic of this.topics) {
      const hasTab = await this.store.hasTopicTab(topic);
      const rows = hasTab ? await this.store.listPanelists(tab(topic)) : [];
      topics.push({ topic, owner: this.ownerOf(topic, team), hasTab, counts: countBuckets(rows), total: rows.length });
    }
    const unpicked = team.filter((m) => m.role === 'owner' && !m.topic);
    return { topics, unpicked };
  }

  /** FR-8: per-owner counts and rows stuck in Outreach 1/2 Sent for 7+ days. */
  async reminders(): Promise<ReminderDigest[]> {
    const team = await this.getTeam(true);
    const out: ReminderDigest[] = [];
    for (const owner of team.filter((m) => m.role === 'owner' && m.topic && m.slackId)) {
      const topic = this.topicByPanel(owner.topic);
      if (!topic || !(await this.store.hasTopicTab(topic))) continue;
      const rows = await this.store.listPanelists(tab(topic));
      const stale = rows
        .filter((r) => STALE_STATUSES.includes(r.data.status.trim().toLowerCase()))
        .map((r) => ({ name: r.data.name, status: r.data.status, days: daysSinceMonthDay(r.data.lastUpdated, this.now()) }))
        .filter((r): r is { name: string; status: string; days: number } => r.days !== undefined && r.days >= STALE_DAYS);
      out.push({ owner, topic, counts: countBuckets(rows), stale });
    }
    return out;
  }

  // ---------------------------------------------------------------- writes

  /** FR-1 Add panelist (with FR-2 duplicate check unless `force`). */
  async addPanelist(
    actor: TeamMember,
    input: UserInput & { notes?: string },
    opts: { topicId?: string; force?: boolean } = {},
  ): Promise<WriteResult> {
    const topic = this.topicForWrite(actor, opts.topicId);
    const lists = await this.getLists();
    const draft = emptyPanelist();
    for (const f of USER_FIELDS) draft[f] = (input[f] ?? '').trim();
    draft.status ||= DEFAULT_STATUS;
    draft.panelA = topic.panel;
    const errors = validatePanelist(draft, lists);
    if (Object.keys(errors).length) throw validation(errors);

    const duplicates = await this.findDuplicates(draft.name);
    if (!opts.force && duplicates.topicMatches.length) {
      throw new PanelError('DUPLICATE', undefined, { kind: 'duplicate', duplicates });
    }

    return this.queue.run(async () => {
      await this.createTopicTab(topic);
      const now = this.now();
      if (input.notes?.trim()) draft.notes = appendNote('', input.notes, actor.name, now);
      const row = applyAutoFields(null, draft, lists, now);
      await this.store.addPanelist(tab(topic), row);
      const diff = `Added to ${topic.tabName} (Status: ${row.status})`;
      await this.store.appendLog(this.logEntry(actor.name, row.name, diff, pickFields(row, nonBlankFields(row))));
      await this.mirror({ kind: 'upsert', topic, before: null, after: row, fields: nonBlankFields(row) });
      const undoId = this.undo.register({
        actorId: actor.slackId,
        topicId: topic.id,
        kind: 'add',
        before: null,
        after: row,
        fields: nonBlankFields(row),
        diff,
      });
      await this.notifyStatus(actor, topic, null, row);
      return { topic, panelist: row, diff, undoId, reference: duplicates.reference };
    });
  }

  /**
   * FR-3 Update. Only changed cells are written. `version` is the row hash from when
   * the modal opened; if the row changed since, throws CONFLICT with the latest row.
   */
  async updatePanelist(
    actor: TeamMember,
    args: { topicId?: string; name: string; version: string; changes: UserInput; note?: string },
  ): Promise<WriteResult> {
    const topic = this.topicForWrite(actor, args.topicId);
    const lists = await this.getLists();
    return this.queue.run(async () => {
      const [current] = (await this.store.hasTopicTab(topic)) ? await this.store.findByName(tab(topic), args.name) : [];
      if (!current) throw new PanelError('NOT_FOUND', `I couldn't find "${args.name}" on ${topic.tabName}.`);
      if (rowVersion(current.data) !== args.version) {
        throw new PanelError('CONFLICT', undefined, { kind: 'conflict', latest: current, version: rowVersion(current.data) });
      }
      const now = this.now();
      const proposed: Panelist = { ...current.data };
      for (const f of USER_FIELDS) if (args.changes[f] !== undefined) proposed[f] = args.changes[f]!.trim();
      proposed.panelA = topic.panel;
      if (args.note?.trim()) proposed.notes = appendNote(current.data.notes, args.note, actor.name, now);

      const userChanged = changedFields(current.data, proposed);
      if (!userChanged.length) throw new PanelError('NO_CHANGES');
      // Validate only what the user changed; legacy values already in the sheet are left alone.
      const errors = pickErrors(validatePanelist(proposed, lists), userChanged);
      if (userChanged.includes('name')) {
        const clash = await this.store.findByName(tab(topic), proposed.name);
        if (clash.some((r) => r.rowIndex !== current.rowIndex)) errors.name = `${proposed.name} is already on this tab.`;
      }
      if (Object.keys(errors).length) throw validation(errors);

      const next = applyAutoFields(current.data, proposed, lists, now);
      const fields = changedFields(current.data, next);
      await this.store.updatePanelist(tab(topic), current.rowIndex, pickFields(next, fields));
      const diff = diffLine(current.data, next, fields);
      await this.store.appendLog(this.logEntry(actor.name, next.name, diff, pickFields(next, fields)));
      await this.mirror({ kind: 'upsert', topic, before: current.data, after: next, fields });
      const undoId = this.undo.register({
        actorId: actor.slackId,
        topicId: topic.id,
        kind: 'update',
        before: current.data,
        after: next,
        fields,
        diff,
      });
      await this.notifyStatus(actor, topic, current.data, next);
      return { topic, panelist: next, diff, undoId };
    });
  }

  /** FR-6 Undo: restores prior values in the topic tab and Panel Tracker; logs an UNDO row. */
  async undoWrite(actor: TeamMember, undoId: string): Promise<{ topic: Topic; name: string }> {
    const rec = this.undo.peek(undoId);
    if (!rec) throw new PanelError('UNDO_UNAVAILABLE');
    if (rec.actorId !== actor.slackId && actor.role !== 'admin') throw new PanelError('FORBIDDEN');
    const topic = this.topicById(rec.topicId);
    return this.queue.run(async () => {
      const [current] = await this.store.findByName(tab(topic), rec.after.name);
      if (!current || rowVersion(current.data) !== rowVersion(rec.after)) throw new PanelError('UNDO_UNAVAILABLE');
      this.undo.consume(undoId);
      if (rec.kind === 'add' || !rec.before) {
        await this.store.clearPanelist(tab(topic), current.rowIndex);
        await this.mirror({ kind: 'clear', topic, name: rec.after.name });
      } else {
        await this.store.updatePanelist(tab(topic), current.rowIndex, pickFields(rec.before, rec.fields));
        await this.mirror({ kind: 'upsert', topic, before: rec.after, after: rec.before, fields: rec.fields });
      }
      await this.store.appendLog(
        this.logEntry(actor.name, rec.after.name, `UNDO: ${rec.diff}`, rec.before ? pickFields(rec.before, rec.fields) : {}),
      );
      return { topic, name: rec.after.name };
    });
  }

  /** FR-10 /panel resync: makes Panel Tracker match the topic tabs, without duplicating rows. */
  async resync(actorName = 'Nightly resync') {
    return this.queue.run(async () => {
      const stats = { added: 0, updated: 0, cleared: 0 };
      const tracker = await this.store.listPanelists(TRACKER);
      const byKey = new Map<string, PanelistRow[]>();
      for (const r of tracker) {
        const k = mirrorKey(r.data.name, r.data.panelA);
        byKey.set(k, [...(byKey.get(k) ?? []), r]);
      }
      const seen = new Set<string>();
      const synced = new Set<string>();
      for (const topic of this.topics) {
        if (!(await this.store.hasTopicTab(topic))) continue;
        synced.add(normalizeName(topic.panel));
        for (const r of await this.store.listPanelists(tab(topic))) {
          const want = { ...r.data, panelA: topic.panel };
          const k = mirrorKey(want.name, topic.panel);
          if (seen.has(k)) continue;
          seen.add(k);
          const [existing, ...extra] = byKey.get(k) ?? [];
          for (const dup of extra) {
            await this.store.clearPanelist(TRACKER, dup.rowIndex);
            stats.cleared++;
          }
          if (!existing) {
            await this.store.addPanelist(TRACKER, want);
            stats.added++;
            continue;
          }
          const fields = changedFields(existing.data, want);
          if (fields.length) {
            await this.store.updatePanelist(TRACKER, existing.rowIndex, pickFields(want, fields));
            stats.updated++;
          }
        }
      }
      // Rows for a panel that has a tab, but no longer on that tab, were removed there.
      for (const [k, rows] of byKey) {
        if (seen.has(k) || !synced.has(normalizeName(rows[0].data.panelA))) continue;
        for (const r of rows) {
          await this.store.clearPanelist(TRACKER, r.rowIndex);
          stats.cleared++;
        }
      }
      await this.store.appendLog(
        this.logEntry(actorName, '', `RESYNC: +${stats.added} added, ${stats.updated} updated, ${stats.cleared} cleared`),
      );
      logger.info('resync.done', stats);
      return stats;
    });
  }

  /** Waits for queued writes and pending mirror retries. Used by tests and shutdown. */
  async settle() {
    while (this.retries.size) await Promise.all([...this.retries]);
    await this.queue.idle();
  }

  // ---------------------------------------------------------------- internals

  /** Runs inside the queue. A failed mirror is logged and retried later from the queue. */
  private async mirror(op: MirrorOp, attempt = 1): Promise<void> {
    try {
      await this.applyMirror(op);
    } catch (err) {
      const name = op.kind === 'clear' ? op.name : op.after.name;
      logger.error('mirror.failed', { name, attempt, ...errorFields(err) });
      const gaveUp = attempt >= this.mirrorRetries;
      await this.store
        .appendLog(this.logEntry('Peter Panel', name, `MIRROR FAILED${gaveUp ? ' (gave up — run /panel resync)' : ''}: ${(err as Error).message}`))
        .catch(() => undefined);
      if (gaveUp) return;
      const retry = new Promise<void>((resolve) => setTimeout(resolve, this.mirrorRetryDelayMs))
        .then(() => this.queue.run(() => this.mirror(op, attempt + 1)))
        .finally(() => this.retries.delete(retry));
      this.retries.add(retry);
    }
  }

  private async applyMirror(op: MirrorOp) {
    const matchName = op.kind === 'clear' ? op.name : (op.before?.name ?? op.after.name);
    const matches = (await this.store.findByName(TRACKER, matchName)).filter((r) => sameName(r.data.panelA, op.topic.panel));
    if (op.kind === 'clear') {
      for (const r of matches) await this.store.clearPanelist(TRACKER, r.rowIndex);
      return;
    }
    const [existing] = matches;
    if (!existing) {
      await this.store.addPanelist(TRACKER, op.after);
      return;
    }
    const fields = op.fields.filter((f) => !sameValue(existing.data[f], op.after[f]));
    if (fields.length) await this.store.updatePanelist(TRACKER, existing.rowIndex, pickFields(op.after, fields));
  }

  /** FR-7: one line to the channel when someone becomes Confirmed or Declined. */
  private async notifyStatus(actor: TeamMember, topic: Topic, before: Panelist | null, after: Panelist) {
    if (before && sameValue(before.status, after.status)) return;
    const company = after.company ? ` (${after.company})` : '';
    if (sameValue(after.status, CONFIRMED_STATUS)) {
      await this.notifier.notify(`:tada: *${after.name}*${company} confirmed for *${topic.panel}* — logged by ${actor.name}`);
    } else if (isDeclined(after.status)) {
      await this.notifier.notify(`:x: *${after.name}*${company} ${after.status.toLowerCase()} for *${topic.panel}* — logged by ${actor.name}`);
    }
  }

  private logEntry(by: string, name: string, update: string, fields: Partial<Panelist> = {}) {
    return { timestamp: chicagoTimestamp(this.now()), submittedBy: by, panelistName: name, update, fields };
  }
}

function mirrorKey(name: string, panel: string) {
  return `${normalizeName(name)}\u0001${normalizeName(panel)}`;
}

function pickFields(p: Panelist, fields: FieldKey[]): Partial<Panelist> {
  return Object.fromEntries(fields.map((f) => [f, p[f]]));
}

function nonBlankFields(p: Panelist): FieldKey[] {
  return (Object.keys(p) as FieldKey[]).filter((f) => p[f].trim());
}

function pickErrors(errors: ValidationErrors, fields: FieldKey[]): ValidationErrors {
  return Object.fromEntries(Object.entries(errors).filter(([f]) => fields.includes(f as FieldKey)));
}

function validation(errors: ValidationErrors) {
  const summary = Object.entries(errors)
    .map(([f, msg]) => `${FIELD_LABELS[f as FieldKey]}: ${msg}`)
    .join(' ');
  return new PanelError('VALIDATION', summary, { kind: 'validation', errors });
}

export function countBuckets(rows: PanelistRow[]): Record<StatusBucket, number> {
  const counts = Object.fromEntries(STATUS_BUCKETS.map((b) => [b, 0])) as Record<StatusBucket, number>;
  for (const r of rows) counts[statusBucket(r.data)]++;
  return counts;
}
