import { randomUUID } from 'node:crypto';
import type { Interpreter, ProposedPanelist } from '../ai/interpreter.js';
import { normalizeName, sameValue } from '../domain/normalize.js';
import { diffLine, rowVersion } from '../domain/rules.js';
import { chicagoMonthDay } from '../domain/time.js';
import { emptyPanelist, FIELD_LABELS, type FieldKey, type PanelistRow, type TeamMember, type Topic } from '../domain/types.js';
import type { PanelService, UserInput, WriteResult } from './PanelService.js';

/** One change Peter Panel proposes from a free-text message, waiting for Apply / Edit / Cancel. */
export interface Proposal {
  id: string;
  actorId: string;
  kind: 'add' | 'update';
  /** Undefined only when a lead adds someone without saying which panel. */
  topicId?: string;
  /** Row name on the tab (update) or the new person's name (add). */
  name: string;
  /** Row hash when proposed; Apply refuses if the row changed since. */
  version?: string;
  changes: UserInput;
  note: string;
  /** Human-readable summary for the confirm card. */
  summary: string;
  createdAt: number;
}

export interface Plan {
  proposals: Proposal[];
  /** Text for the author when there's nothing to apply (or as a heads-up). */
  reply: string;
}

const PROPOSAL_TTL_MS = 60 * 60 * 1000;

/**
 * FR-9: free-text updates. Claude proposes changes; this matches them to real rows,
 * applies the same permissions as the forms, and holds them until confirmed.
 * Nothing is written without an explicit Apply.
 */
export class FreeTextPlanner {
  private readonly pending = new Map<string, Proposal>();

  constructor(
    private readonly service: PanelService,
    private readonly interpreter: Interpreter,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async plan(actor: TeamMember, text: string): Promise<Plan> {
    const topics = await this.service.topicsFor(actor); // throws nothing; owners without a topic get []
    if (actor.role !== 'admin' && !topics.length) this.service.topicForWrite(actor); // "Pick your topic first"
    const rowsByTopic = new Map<string, PanelistRow[]>();
    for (const t of topics) rowsByTopic.set(t.id, (await this.service.listTopic(actor, t.id)).rows);

    const interpretation = await this.interpreter.interpret({
      text,
      author: actor.name,
      panels: topics.map((topic) => ({ topic, panelists: (rowsByTopic.get(topic.id) ?? []).map((r) => r.data) })),
      lists: await this.service.getLists(),
      today: chicagoMonthDay(this.now()),
    });

    const proposals: Proposal[] = [];
    const notes: string[] = [];
    for (const p of interpretation.panelists) {
      const proposal = this.resolve(actor, p, topics, rowsByTopic);
      if (proposal) proposals.push(proposal);
      else notes.push(`Nothing new for *${p.name}* — the tracker already says that.`);
    }
    this.prune();
    for (const p of proposals) this.pending.set(p.id, p);
    return { proposals, reply: [interpretation.reply, ...notes].filter(Boolean).join('\n') };
  }

  private resolve(actor: TeamMember, p: ProposedPanelist, topics: Topic[], rowsByTopic: Map<string, PanelistRow[]>): Proposal | null {
    const hinted = topics.find((t) => t.id === p.topicId);
    const match = findRow(p.name, hinted ? [hinted, ...topics.filter((t) => t !== hinted)] : topics, rowsByTopic);
    const base = { id: randomUUID(), actorId: actor.slackId, note: p.note, createdAt: this.now().getTime() };

    if (match) {
      const before = match.row.data;
      const changes: UserInput = {};
      for (const [k, v] of Object.entries(p.changes)) {
        if (v && !sameValue(before[k as FieldKey], v)) changes[k as keyof UserInput] = v;
      }
      if (!Object.keys(changes).length && !p.note) return null;
      const after = { ...before, ...changes };
      const lines = [diffLine(before, after, Object.keys(changes) as FieldKey[]), p.note && `Note: ${p.note}`].filter(Boolean);
      return {
        ...base,
        kind: 'update',
        topicId: match.topic.id,
        name: before.name,
        version: rowVersion(before),
        changes,
        summary: `Update *${before.name}* on *${match.topic.tabName}*\n${lines.join('\n')}`,
      };
    }

    const topicId = actor.role === 'admin' ? hinted?.id : topics[0]?.id;
    const topic = topics.find((t) => t.id === topicId);
    const fields = Object.entries(p.changes).map(([k, v]) => `${FIELD_LABELS[k as FieldKey]}: ${v}`);
    return {
      ...base,
      kind: 'add',
      topicId,
      name: p.name,
      changes: { ...p.changes },
      summary: [
        `Add *${p.name}* to ${topic ? `*${topic.tabName}*` : '_a panel (choose one with Edit)_'}`,
        fields.join(' · '),
        p.note && `Note: ${p.note}`,
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  get(id: string): Proposal | undefined {
    const p = this.pending.get(id);
    return p && this.now().getTime() - p.createdAt < PROPOSAL_TTL_MS ? p : undefined;
  }

  discard(id: string) {
    this.pending.delete(id);
  }

  /** Writes a proposal. Same permission checks, validation and conflict detection as the forms. */
  async apply(actor: TeamMember, id: string, opts: { force?: boolean } = {}): Promise<{ proposal: Proposal; result: WriteResult }> {
    const proposal = this.get(id);
    if (!proposal) throw new Error('That suggestion has expired. Send the update again.');
    if (proposal.actorId !== actor.slackId && actor.role !== 'admin') throw new Error('Only the person who sent the update can apply it.');
    const result =
      proposal.kind === 'update'
        ? await this.service.updatePanelist(actor, {
            topicId: proposal.topicId,
            name: proposal.name,
            version: proposal.version!,
            changes: proposal.changes,
            note: proposal.note,
          })
        : await this.service.addPanelist(actor, { ...proposal.changes, name: proposal.name, notes: proposal.note }, { topicId: proposal.topicId, force: opts.force });
    this.pending.delete(id);
    return { proposal, result };
  }

  private prune() {
    const cutoff = this.now().getTime() - PROPOSAL_TTL_MS;
    for (const [id, p] of this.pending) if (p.createdAt < cutoff) this.pending.delete(id);
  }
}

/** Exact (normalized) name match first; else a single unambiguous partial match, e.g. "Joe" → "Joe Johnson". */
export function findRow(name: string, topics: Topic[], rowsByTopic: Map<string, PanelistRow[]>) {
  const key = normalizeName(name);
  const all = topics.flatMap((topic) => (rowsByTopic.get(topic.id) ?? []).map((row) => ({ topic, row })));
  const exact = all.find((x) => normalizeName(x.row.data.name) === key);
  if (exact) return exact;
  const partial = all.filter((x) => {
    const n = normalizeName(x.row.data.name);
    return key.length >= 3 && (n.startsWith(`${key} `) || n.includes(key) || key.includes(n));
  });
  return partial.length === 1 ? partial[0] : undefined;
}

/** The panelist as it would look after a proposal, for pre-filling the Edit form. */
export function proposedRow(p: Proposal, current?: PanelistRow) {
  return { ...(current?.data ?? { ...emptyPanelist(), name: p.name }), ...p.changes };
}
