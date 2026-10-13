import type { KnownBlock } from '@slack/types';
import { STATUS_BUCKETS } from '../domain/rules.js';
import type { Panelist, PanelistRow, ReferenceRow, TeamMember, Topic } from '../domain/types.js';
import type { Duplicates } from '../service/errors.js';
import type { ReminderDigest, TopicStatus, WriteResult } from '../service/PanelService.js';
import { encodeRef } from './parse.js';
import { ACTION } from './views.js';

const MAX_BLOCKS = 48;

export const HELP = [
  '*Peter Panel* — log KCC 2026 panelist outreach without opening Excel.',
  '',
  '`/panel pick` — claim your panel (creates its tab)',
  '`/panel add` — add a panelist to your panel',
  '`/panel update [name]` — update someone on your panel',
  '`/panel list` — your panel’s panelists by status',
  '`/panel find <name>` — search every panel and last year’s list',
  '',
  '*Leads only*',
  '`/panel status` — counts per panel, and who hasn’t picked',
  '`/panel assign @user <panel>` — set or change someone’s panel',
  '`/panel list <panel>` — any panel’s list',
  '`/panel resync` — rebuild Panel Tracker from the topic tabs',
  '`/panel reload` — re-read Team, topics and dropdown lists',
].join('\n');

export function pickFirstBlocks(): KnownBlock[] {
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: 'Pick your topic first.' },
      accessory: { type: 'button', action_id: ACTION.openPick, text: { type: 'plain_text', text: 'Pick' }, style: 'primary' },
    },
  ];
}

function updateButton(topic: Topic, name: string) {
  return { type: 'button' as const, action_id: ACTION.openUpdate, text: { type: 'plain_text' as const, text: 'Update' }, value: encodeRef(topic.id, name) };
}

function who(p: Panelist) {
  return [p.role, p.company].filter(Boolean).join(', ');
}

/** FR-6: summary of a write, with an Undo button valid for 10 minutes. */
export function writeSummaryBlocks(verb: 'Added' | 'Updated', r: WriteResult): KnownBlock[] {
  const lines = [`:white_check_mark: ${verb} *${r.panelist.name}* on *${r.topic.tabName}*`, r.diff];
  for (const ref of r.reference ?? []) {
    lines.push(`:books: In 2025: ${ref.status || 'no status'}${ref.panel ? ` for ${ref.panel}` : ''}${ref.notes ? ` — ${ref.notes.slice(0, 300)}` : ''}`);
  }
  return [
    { type: 'section', text: { type: 'mrkdwn', text: lines.filter(Boolean).join('\n').slice(0, 3000) } },
    {
      type: 'actions',
      elements: [
        { type: 'button', action_id: ACTION.undo, text: { type: 'plain_text', text: 'Undo' }, value: r.undoId },
        updateButton(r.topic, r.panelist.name),
      ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: 'Undo works for 10 minutes.' }] },
  ];
}

export function duplicateLines(name: string, d: Duplicates): string[] {
  const lines = d.topicMatches.map((m) => `:warning: *${name}* is already on *${m.topic.tabName}* (owner ${m.owner}), status *${m.status || 'blank'}*.`);
  for (const r of d.reference) {
    lines.push(`:books: Last year: ${r.status || 'no status'}${r.company ? `, ${r.company}` : ''}${r.notes ? ` — ${r.notes.slice(0, 300)}` : ''}`);
  }
  lines.push('', 'Add them anyway?');
  return lines;
}

/** /panel list: grouped by Outreach Status, each with an Update button. */
export function listBlocks(topic: Topic, rows: PanelistRow[], statusOrder: string[]): KnownBlock[] {
  if (!rows.length) return [{ type: 'section', text: { type: 'mrkdwn', text: `*${topic.panel}* has no panelists yet. Add one with \`/panel add\`.` } }];
  const groups = new Map<string, PanelistRow[]>();
  for (const r of rows) {
    const s = r.data.status.trim() || '(no status)';
    groups.set(s, [...(groups.get(s) ?? []), r]);
  }
  const order = [...statusOrder, ...[...groups.keys()].filter((s) => !statusOrder.includes(s))];
  const blocks: KnownBlock[] = [{ type: 'header', text: { type: 'plain_text', text: `${topic.panel} — ${rows.length} panelists`.slice(0, 150) } }];
  let shown = 0;
  for (const status of order) {
    const group = groups.get(status);
    if (!group) continue;
    if (blocks.length >= MAX_BLOCKS - 2) break;
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `*${status}* (${group.length})` }] });
    for (const r of group) {
      if (blocks.length >= MAX_BLOCKS - 1) break;
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${r.data.name}*${who(r.data) ? ` — ${who(r.data)}` : ''}${r.data.lastUpdated ? `  _(${r.data.lastUpdated})_` : ''}` },
        accessory: updateButton(topic, r.data.name),
      });
      shown++;
    }
  }
  if (shown < rows.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `…and ${rows.length - shown} more. Use \`/panel update <name>\`.` }] });
  }
  return blocks;
}

const pad = (s: string | number, n: number) => String(s).slice(0, n).padEnd(n);

/** /panel status: topics × bucket counts, plus owners who haven't picked. */
export function statusText(topics: TopicStatus[], unpicked: TeamMember[]): string {
  const head = `${pad('#', 3)}${pad('Panel', 14)}${pad('Owner', 16)}${STATUS_BUCKETS.map((b) => pad(b === 'In outreach' ? 'Outreach' : b === 'Not started' ? 'NotStart' : b, 10)).join('')}`;
  const lines = topics.map(
    (t) =>
      `${pad(t.topic.number, 3)}${pad(t.topic.alias, 14)}${pad(t.owner?.name ?? '— gap —', 16)}${STATUS_BUCKETS.map((b) => pad(t.hasTab ? t.counts[b] : '·', 10)).join('')}`,
  );
  const totals = STATUS_BUCKETS.map((b) => topics.reduce((n, t) => n + t.counts[b], 0));
  lines.push(`${pad('', 3)}${pad('Total', 30)}${totals.map((n) => pad(n, 10)).join('')}`);
  const out = ['*Panel status*', '```', head, ...lines, '```'];
  out.push(unpicked.length ? `*Hasn’t picked a panel:* ${unpicked.map((m) => m.name).join(', ')}` : 'Every owner has picked a panel.');
  const gaps = topics.filter((t) => !t.owner).map((t) => t.topic.alias);
  if (gaps.length) out.push(`*No owner (leads cover these):* ${gaps.join(', ')}`);
  return out.join('\n');
}

export function findText(query: string, current: { topic: Topic; owner: string; row: Panelist }[], reference: ReferenceRow[]): string {
  if (!current.length && !reference.length) return `No one matching "${query}" on any panel or in last year’s list.`;
  const lines: string[] = [];
  if (current.length) {
    lines.push('*This year*');
    for (const c of current.slice(0, 20)) {
      lines.push(`• *${c.row.name}*${who(c.row) ? ` — ${who(c.row)}` : ''} · ${c.topic.tabName} (${c.owner}) · ${c.row.status || 'no status'}`);
    }
  }
  if (reference.length) {
    lines.push('*2025 reference*');
    for (const r of reference.slice(0, 10)) {
      lines.push(`• *${r.name}*${who(r) ? ` — ${who(r)}` : ''} · ${r.status || 'no status'}${r.panelA ? ` · ${r.panelA}` : ''}${r.notes ? ` · ${r.notes.slice(0, 200)}` : ''}`);
    }
  }
  return lines.join('\n').slice(0, 3900);
}

/** FR-8: the Monday DM to one owner. */
export function reminderBlocks(d: ReminderDigest): KnownBlock[] {
  const counts = STATUS_BUCKETS.map((b) => `${b}: *${d.counts[b]}*`).join(' · ');
  const blocks: KnownBlock[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `:wave: Weekly check-in for *${d.topic.panel}*\n${counts}` } },
  ];
  if (d.stale.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'No update in 7+ days:' }] });
    for (const s of d.stale.slice(0, 40)) {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${s.name}* — ${s.status}, ${s.days} days` },
        accessory: updateButton(d.topic, s.name),
      });
    }
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Nothing stuck in Outreach Sent. Nice.' }] });
  }
  return blocks;
}
