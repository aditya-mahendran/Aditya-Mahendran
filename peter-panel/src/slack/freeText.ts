import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { errorFields, logger } from '../logger.js';
import { isPanelError, MESSAGES, PanelError } from '../service/errors.js';
import type { FreeTextPlanner, Proposal } from '../service/FreeTextPlanner.js';
import { proposedRow } from '../service/FreeTextPlanner.js';
import type { PanelService } from '../service/PanelService.js';
import { errorText, makeActorFor, reply } from './common.js';
import { duplicateLines, pickFirstBlocks, writeSummaryBlocks } from './format.js';
import { loadingView, messageView, panelistForm } from './views.js';

export const AI_ACTION = {
  apply: 'ai_apply',
  force: 'ai_force',
  edit: 'ai_edit',
  cancel: 'ai_cancel',
} as const;

const button = (actionId: string, text: string, value: string, style?: 'primary' | 'danger') => ({
  type: 'button' as const,
  action_id: actionId,
  text: { type: 'plain_text' as const, text },
  value,
  ...(style ? { style } : {}),
});

/** Confirm card for one proposal: Apply / Edit / Cancel. Nothing is written until Apply. */
export function proposalBlocks(p: Proposal): KnownBlock[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: p.summary.slice(0, 3000) } },
    {
      type: 'actions',
      elements: [
        ...(p.topicId ? [button(AI_ACTION.apply, p.kind === 'add' ? 'Add' : 'Apply', p.id, 'primary')] : []),
        button(AI_ACTION.edit, 'Edit', p.id),
        button(AI_ACTION.cancel, 'Cancel', p.id),
      ],
    },
  ];
}

/**
 * Turns Slack markup into plain text for Claude: drops the bot's own mention and
 * resolves other @mentions, channels and links to readable names.
 */
export async function cleanSlackText(text: string, botUserId: string | undefined, nameOf: (id: string) => Promise<string>) {
  let out = botUserId ? text.replaceAll(`<@${botUserId}>`, '') : text;
  const ids = [...new Set([...out.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)].map((m) => m[1]))];
  for (const id of ids) {
    const name = await nameOf(id).catch(() => id);
    out = out.replace(new RegExp(`<@${id}(?:\\|[^>]*)?>`, 'g'), `@${name}`);
  }
  return out
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

interface Source {
  channel: string;
  ts: string;
  threadTs: string;
  isDm: boolean;
}

/**
 * FR-9: "@Peter Panel talked to Joe, he's interested, wants to moderate" in a channel,
 * or the same as a DM. Claude proposes the changes; the author confirms.
 */
export function registerFreeText(app: App, service: PanelService, planner: FreeTextPlanner | null) {
  const actorFor = makeActorFor(service);
  const sources = new Map<string, Source>();
  const names = new Map<string, string>();

  async function nameOf(client: WebClient, id: string) {
    if (!names.has(id)) {
      const info = await client.users.info({ user: id });
      names.set(id, info.user?.real_name || info.user?.profile?.display_name || info.user?.name || id);
    }
    return names.get(id)!;
  }

  async function react(client: WebClient, src: Pick<Source, 'channel' | 'ts'>, name: string, remove = false) {
    try {
      await (remove ? client.reactions.remove : client.reactions.add)({ channel: src.channel, timestamp: src.ts, name });
    } catch {
      // reactions:write missing or already reacted; purely cosmetic
    }
  }

  async function send(client: WebClient, src: Source, userId: string, text: string, blocks?: KnownBlock[]) {
    if (src.isDm) await client.chat.postMessage({ channel: src.channel, text, blocks });
    else await reply(client, src.channel, userId, text, blocks, src.threadTs);
  }

  async function handle(client: WebClient, userId: string, rawText: string, src: Source, botUserId?: string) {
    if (!planner) {
      await send(client, src, userId, 'Free-text updates aren’t switched on yet (ANTHROPIC_API_KEY isn’t set). Use `/panel update` for now.');
      return;
    }
    const text = await cleanSlackText(rawText, botUserId, (id) => nameOf(client, id));
    if (!text) {
      await send(client, src, userId, 'Tell me about someone you reached out to, e.g. “@Peter Panel talked to Jane Doe, she’s interested and wants to moderate.”');
      return;
    }
    try {
      const actor = await actorFor(client, userId);
      await react(client, src, 'eyes');
      const plan = await planner.plan(actor, text);
      await react(client, src, 'eyes', true);
      if (!plan.proposals.length) {
        await send(client, src, userId, plan.reply || "I couldn't tell who that update is about. Mention them by name?");
        return;
      }
      for (const p of plan.proposals) sources.set(p.id, src);
      const blocks: KnownBlock[] = [
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Here’s what I’d change. Nothing is saved until you confirm.' }] },
        ...plan.proposals.flatMap((p) => [...proposalBlocks(p), { type: 'divider' } as KnownBlock]),
        ...(plan.reply ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: plan.reply }] } as KnownBlock] : []),
      ];
      await send(client, src, userId, `Proposed tracker update (${plan.proposals.length})`, blocks.slice(0, 50));
    } catch (err) {
      await react(client, src, 'eyes', true);
      if (isPanelError(err, 'NO_TOPIC')) return send(client, src, userId, MESSAGES.NO_TOPIC, pickFirstBlocks());
      if (isPanelError(err)) return send(client, src, userId, err.message);
      logger.error('freetext.failed', errorFields(err));
      await send(client, src, userId, `Sorry, I couldn't process that: ${(err as Error).message}`);
    }
  }

  app.event('app_mention', async ({ event, client, context }) => {
    if (!event.user || ('bot_id' in event && event.bot_id)) return;
    await handle(client, event.user, event.text, { channel: event.channel, ts: event.ts, threadTs: event.thread_ts ?? event.ts, isDm: false }, context.botUserId);
  });

  app.message(async ({ message, client, context }) => {
    if (message.channel_type !== 'im' || message.subtype || !('user' in message) || !message.user || ('bot_id' in message && message.bot_id)) return;
    const text = 'text' in message ? (message.text ?? '') : '';
    await handle(client, message.user, text, { channel: message.channel, ts: message.ts, threadTs: message.ts, isDm: true }, context.botUserId);
  });

  // ------------------------------------------------------------ card buttons

  type ActionBody = { user: { id: string }; trigger_id: string; channel?: { id: string }; actions: { value?: string }[] };

  async function applyProposal(id: string, userId: string, client: WebClient, respond: (m: Record<string, unknown>) => Promise<unknown>, force = false) {
    const src = sources.get(id);
    try {
      const actor = await actorFor(client, userId);
      const { proposal, result } = await planner!.apply(actor, id, { force });
      sources.delete(id);
      await respond({ replace_original: true, text: `Saved ${result.panelist.name}`, blocks: writeSummaryBlocks(proposal.kind === 'add' ? 'Added' : 'Updated', result) });
      if (src) await react(client, src, 'white_check_mark');
    } catch (err) {
      const proposal = planner!.get(id);
      if (err instanceof PanelError && err.data?.kind === 'duplicate' && proposal) {
        await respond({
          replace_original: true,
          text: 'Possible duplicate',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: duplicateLines(proposal.name, err.data.duplicates).join('\n') } },
            { type: 'actions', elements: [button(AI_ACTION.force, 'Add anyway', id, 'primary'), button(AI_ACTION.cancel, 'Cancel', id)] },
          ],
        });
        return;
      }
      if (err instanceof PanelError && err.data?.kind === 'conflict' && proposal) {
        await respond({
          replace_original: true,
          text: MESSAGES.CONFLICT,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: `:warning: *${proposal.name}* changed since I read the tracker. Open it in a form to review the latest before saving.` } },
            { type: 'actions', elements: [button(AI_ACTION.edit, 'Edit', id, 'primary'), button(AI_ACTION.cancel, 'Cancel', id)] },
          ],
        });
        return;
      }
      await respond({ replace_original: false, response_type: 'ephemeral', text: err instanceof PanelError ? err.message : errorText(err) });
    }
  }

  app.action(AI_ACTION.apply, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as ActionBody;
    await applyProposal(b.actions[0]?.value ?? '', b.user.id, client, respond);
  });

  app.action(AI_ACTION.force, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as ActionBody;
    await applyProposal(b.actions[0]?.value ?? '', b.user.id, client, respond, true);
  });

  app.action(AI_ACTION.cancel, async ({ ack, body, respond }) => {
    await ack();
    const id = (body as ActionBody).actions[0]?.value ?? '';
    planner?.discard(id);
    sources.delete(id);
    await respond({ replace_original: true, text: 'Cancelled — nothing was changed.' });
  });

  /** Opens the normal Add / Update form, pre-filled with the proposal, so the author can adjust it. */
  app.action(AI_ACTION.edit, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as ActionBody;
    const id = b.actions[0]?.value ?? '';
    const proposal = planner?.get(id);
    if (!proposal) {
      await respond({ replace_original: true, text: 'That suggestion has expired. Send the update again.' });
      return;
    }
    const opened = await client.views.open({ trigger_id: b.trigger_id, view: loadingView(proposal.kind === 'add' ? 'Add panelist' : 'Update panelist') });
    const viewId = opened.view!.id!;
    const src = sources.get(id);
    const meta = { channelId: src && !src.isDm ? src.channel : b.channel?.id };
    try {
      const actor = await actorFor(client, b.user.id);
      const lists = await service.getLists();
      if (proposal.kind === 'update') {
        const { topic, row, version } = await service.getPanelist(actor, proposal.topicId, proposal.name);
        await client.views.update({
          view_id: viewId,
          view: panelistForm({
            mode: 'update',
            lists,
            topic,
            initial: proposedRow(proposal, row),
            noteDraft: proposal.note,
            meta: { ...meta, topicId: topic.id, name: row.data.name, version },
          }),
        });
      } else {
        await client.views.update({
          view_id: viewId,
          view: panelistForm({
            mode: 'add',
            lists,
            initial: proposedRow(proposal),
            noteDraft: proposal.note,
            meta: { ...meta, topicId: proposal.topicId },
            topics: actor.role === 'admin' ? service.topics : undefined,
            topic: actor.role === 'admin' ? undefined : service.topicForWrite(actor),
          }),
        });
      }
      planner!.discard(id);
      await respond({ replace_original: true, text: `:pencil2: Opened *${proposal.name}* in a form — save it there.` });
    } catch (err) {
      await client.views.update({ view_id: viewId, view: messageView('Peter Panel', errorText(err)) });
    }
  });
}
