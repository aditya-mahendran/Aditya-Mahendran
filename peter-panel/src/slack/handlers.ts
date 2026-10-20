import { randomUUID } from 'node:crypto';
import type { App } from '@slack/bolt';
import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import { validatePanelist } from '../domain/rules.js';
import { emptyPanelist, FIELD_LABELS, type FieldKey, type Panelist, type TeamMember } from '../domain/types.js';
import { errorFields, logger } from '../logger.js';
import { errorText, makeActorFor, reply } from './common.js';
import { isPanelError, MESSAGES, PanelError } from '../service/errors.js';
import type { PanelService, UserInput } from '../service/PanelService.js';
import {
  duplicateLines,
  findText,
  HELP,
  listBlocks,
  pickFirstBlocks,
  statusText,
  writeSummaryBlocks,
} from './format.js';
import { decodeRef, encodeRef, formInitial, parseAssign, parseCommand, parseForm, parseMeta, type ParsedForm } from './parse.js';
import {
  ACTION,
  CB,
  duplicateView,
  loadingView,
  messageView,
  panelistForm,
  pickView,
  savingView,
  updateSelectView,
  type ModalMeta,
} from './views.js';

/** Adds that hit the duplicate warning wait here until "Add anyway" (or expire). */
interface PendingAdd {
  form: ParsedForm;
  meta: ModalMeta;
  at: number;
}
const PENDING_TTL_MS = 30 * 60 * 1000;

export function registerHandlers(app: App, service: PanelService) {
  const pending = new Map<string, PendingAdd>();

  const actorFor = makeActorFor(service);

  // ------------------------------------------------------------ /panel

  app.command('/panel', async ({ command, ack, client, respond }) => {
    await ack();
    const { sub, rest } = parseCommand(command.text ?? '');
    const userId = command.user_id;
    const channelId = command.channel_id;
    const meta: ModalMeta = { channelId };
    const ephemeral = (text: string, blocks?: KnownBlock[]) => respond({ response_type: 'ephemeral', text, blocks });

    try {
      if (sub === 'help') return void (await ephemeral(HELP));
      const actor = await actorFor(client, userId);

      switch (sub) {
        case 'pick': {
          if (actor.role === 'admin') return void (await ephemeral('Leads work across every panel — use `/panel assign @user <panel>` to give one to an owner.'));
          if (actor.topic) return void (await ephemeral(`You own *${actor.topic}*. ${MESSAGES.ALREADY_PICKED}`));
          await client.views.open({ trigger_id: command.trigger_id, view: pickView(await service.unclaimedTopics(), meta) });
          return;
        }
        case 'add': {
          const lists = await service.getLists();
          if (actor.role === 'admin') {
            await client.views.open({ trigger_id: command.trigger_id, view: panelistForm({ mode: 'add', lists, meta, topics: service.topics }) });
          } else {
            const topic = service.topicForWrite(actor);
            await client.views.open({ trigger_id: command.trigger_id, view: panelistForm({ mode: 'add', lists, meta, topic }) });
          }
          return;
        }
        case 'update': {
          if (actor.role !== 'admin') service.topicForWrite(actor); // "Pick your topic first"
          if (!rest) {
            await client.views.open({ trigger_id: command.trigger_id, view: updateSelectView(meta) });
            return;
          }
          const opened = await client.views.open({ trigger_id: command.trigger_id, view: loadingView('Update panelist') });
          const viewId = opened.view!.id!;
          const matches = (await service.searchNames(actor, rest)).filter((m) => m.name.trim().toLowerCase() === rest.trim().toLowerCase());
          const target = matches.length === 1 ? matches[0] : undefined;
          if (!target) {
            await client.views.update({
              view_id: viewId,
              view: updateSelectView(meta, matches.length ? `"${rest}" is on more than one panel — choose below.` : `I couldn't find "${rest}". Search below.`),
            });
            return;
          }
          await showUpdateForm(client, viewId, actor, target.topic.id, target.name, meta);
          return;
        }
        case 'list': {
          const topicId = actor.role === 'admin' ? (rest ? service.resolveTopic(rest).id : undefined) : undefined;
          if (actor.role === 'admin' && !topicId) return void (await ephemeral('Which panel? e.g. `/panel list 3` or `/panel list Air Time`. For every panel, try `/panel status`.'));
          const { topic, rows } = await service.listTopic(actor, topicId);
          const lists = await service.getLists();
          await ephemeral(`${topic.panel}: ${rows.length} panelists`, listBlocks(topic, rows, lists.status));
          return;
        }
        case 'status': {
          service.requireAdmin(actor);
          const { topics, unpicked } = await service.status();
          await ephemeral(statusText(topics, unpicked));
          return;
        }
        case 'find': {
          if (!rest) return void (await ephemeral('Usage: `/panel find <name>`'));
          const { current, reference } = await service.find(rest);
          await ephemeral(findText(rest, current, reference));
          return;
        }
        case 'assign': {
          service.requireAdmin(actor);
          const parsed = parseAssign(rest);
          if (!parsed) return void (await ephemeral('Usage: `/panel assign @user <panel number or name>`'));
          const topic = service.resolveTopic(parsed.topicText);
          const info = await client.users.info({ user: parsed.userId }).catch(() => null);
          const result = await service.assign(actor, parsed.userId, topic.id, {
            realName: info?.user?.real_name ?? info?.user?.profile?.real_name,
            displayName: info?.user?.profile?.display_name,
          });
          const was = result.previous ? ` (${result.previous.name} no longer has a panel)` : '';
          await ephemeral(`:white_check_mark: ${result.target.name} now owns *${topic.panel}*${was}.`);
          return;
        }
        case 'resync': {
          service.requireAdmin(actor);
          await ephemeral(':arrows_counterclockwise: Resyncing Panel Tracker from the topic tabs…');
          const s = await service.resync(actor.name);
          await ephemeral(`:white_check_mark: Panel Tracker resynced: ${s.added} added, ${s.updated} updated, ${s.cleared} cleared.`);
          return;
        }
        case 'reload': {
          service.requireAdmin(actor);
          const r = await service.reload();
          await ephemeral(`:white_check_mark: Reloaded: ${r.team} people on Team, ${r.lists.status.length} statuses, ${r.lists.panelA.length} panels.`);
          return;
        }
      }
    } catch (err) {
      if (isPanelError(err, 'NO_TOPIC')) return void (await ephemeral(MESSAGES.NO_TOPIC, pickFirstBlocks()));
      await ephemeral(errorText(err));
    }
  });

  // ------------------------------------------------------------ pick (FR-0)

  app.action(ACTION.openPick, async ({ ack, body, client }) => {
    await ack();
    const b = body as { trigger_id: string; user: { id: string }; channel?: { id: string } };
    await client.views.open({ trigger_id: b.trigger_id, view: pickView(await service.unclaimedTopics(), { channelId: b.channel?.id }) });
  });

  app.view(CB.pick, async ({ ack, body, view, client }) => {
    const meta = parseMeta(view);
    const topicId = view.state.values.topic?.v?.selected_option?.value;
    if (!topicId) return void (await ack({ response_action: 'errors', errors: { topic: 'Choose a panel.' } }));
    await ack({ response_action: 'update', view: savingView() });
    try {
      const actor = await actorFor(client, body.user.id);
      const topic = await service.pick(actor, topicId);
      await client.views.update({ view_id: view.id, view: messageView('Panel picked', `:tada: You own *${topic.panel}*. Its green tab is ready — add panelists with \`/panel add\`.`) });
      await reply(client, meta.channelId, body.user.id, `You own *${topic.panel}*.`);
    } catch (err) {
      const error = isPanelError(err, 'TAKEN') ? MESSAGES.TAKEN : errorText(err);
      await client.views.update({ view_id: view.id, view: pickView(await service.unclaimedTopics(), meta, error) });
    }
  });

  // ------------------------------------------------------------ add (FR-1, FR-2)

  async function saveAdd(client: WebClient, userId: string, viewId: string, form: ParsedForm, meta: ModalMeta, force: boolean) {
    const actor = await actorFor(client, userId);
    try {
      const result = await service.addPanelist(actor, { ...form.input, notes: form.notes }, { topicId: form.topicId ?? meta.topicId, force });
      await client.views.update({ view_id: viewId, view: messageView('Saved', `:white_check_mark: Added *${result.panelist.name}* to *${result.topic.tabName}*.`) });
      await reply(client, meta.channelId, userId, `Added ${result.panelist.name}`, writeSummaryBlocks('Added', result));
    } catch (err) {
      if (err instanceof PanelError && err.data?.kind === 'duplicate') {
        const pendingId = randomUUID();
        prunePending();
        pending.set(pendingId, { form, meta, at: Date.now() });
        await client.views.update({ view_id: viewId, view: duplicateView(duplicateLines(form.input.name ?? '', err.data.duplicates), { ...meta, pendingId }) });
        return;
      }
      if (isPanelError(err, 'NO_TOPIC')) {
        await client.views.update({ view_id: viewId, view: messageView('Pick your panel', 'Pick your topic first with `/panel pick`.') });
        return;
      }
      const lists = await service.getLists();
      await client.views.update({
        view_id: viewId,
        view: panelistForm({
          mode: 'add',
          lists,
          meta: { ...meta, topicId: form.topicId ?? meta.topicId },
          initial: { ...formInitial(form), notes: undefined },
          topics: actor.role === 'admin' ? service.topics : undefined,
          topic: actor.role === 'admin' ? undefined : service.topicForWrite(actor),
          error: `Couldn't save: ${errorText(err)} Your inputs are kept — fix and save again.`,
        }),
      });
    }
  }

  function prunePending() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, p] of pending) if (p.at < cutoff) pending.delete(id);
  }

  app.view(CB.add, async ({ ack, body, view, client }) => {
    const meta = parseMeta(view);
    const form = parseForm(view.state.values as never);
    const errors = await inlineErrors(form);
    if (Object.keys(errors).length) return void (await ack({ response_action: 'errors', errors }));
    await ack({ response_action: 'update', view: savingView() });
    await saveAdd(client, body.user.id, view.id, form, meta, false);
  });

  app.view(CB.duplicate, async ({ ack, body, view, client }) => {
    const meta = parseMeta(view);
    const p = meta.pendingId ? pending.get(meta.pendingId) : undefined;
    if (!p) return void (await ack({ response_action: 'update', view: messageView('Expired', 'That draft expired. Run `/panel add` again.') }));
    pending.delete(meta.pendingId!);
    await ack({ response_action: 'update', view: savingView() });
    await saveAdd(client, body.user.id, view.id, p.form, p.meta, true);
  });

  /** Required name, and dropdown values the workbook accepts — shown inline on the field. */
  async function inlineErrors(form: ParsedForm): Promise<Record<string, string>> {
    const errors: Record<string, string> = {};
    if (!form.input.name?.trim()) errors.name = 'Name is required.';
    const lists = await service.getLists();
    const draft = { ...emptyPanelist(), ...form.input, name: form.input.name || 'x' } as Panelist;
    for (const [f, msg] of Object.entries(validatePanelist(draft, lists))) {
      if (f in form.input) errors[f] = msg!;
    }
    return errors;
  }

  // ------------------------------------------------------------ update (FR-3)

  async function showUpdateForm(client: WebClient, viewId: string, actor: TeamMember, topicId: string, name: string, meta: ModalMeta, error?: string) {
    try {
      const { topic, row, version } = await service.getPanelist(actor, topicId, name);
      const lists = await service.getLists();
      await client.views.update({
        view_id: viewId,
        view: panelistForm({ mode: 'update', lists, topic, initial: row.data, meta: { ...meta, topicId: topic.id, name: row.data.name, version }, error }),
      });
    } catch (err) {
      await client.views.update({ view_id: viewId, view: messageView('Update panelist', errorText(err)) });
    }
  }

  app.options(ACTION.updatePick, async ({ ack, body, client }) => {
    try {
      const actor = await actorFor(client, body.user.id);
      const matches = await service.searchNames(actor, (body as { value?: string }).value ?? '');
      const multiTopic = actor.role === 'admin';
      await ack({
        options: matches.map((m) => ({
          text: { type: 'plain_text', text: `${m.name}${multiTopic ? ` — ${m.topic.alias}` : ''}${m.status ? ` (${m.status})` : ''}`.slice(0, 75) },
          value: encodeRef(m.topic.id, m.name),
        })),
      });
    } catch (err) {
      logger.warn('options.failed', errorFields(err));
      await ack({ options: [] });
    }
  });

  app.action(ACTION.updatePick, async ({ ack, body, client }) => {
    await ack();
    const b = body as { user: { id: string }; view?: { id: string; private_metadata?: string }; actions: { selected_option?: { value: string } }[] };
    const value = b.actions[0]?.selected_option?.value;
    if (!b.view || !value) return;
    const { topicId, name } = decodeRef(value);
    const actor = await actorFor(client, b.user.id);
    await showUpdateForm(client, b.view.id, actor, topicId, name, parseMeta(b.view));
  });

  app.action(ACTION.openUpdate, async ({ ack, body, client }) => {
    await ack();
    const b = body as { trigger_id: string; user: { id: string }; channel?: { id: string }; actions: { value?: string }[] };
    const opened = await client.views.open({ trigger_id: b.trigger_id, view: loadingView('Update panelist') });
    const { topicId, name } = decodeRef(b.actions[0]?.value ?? '');
    try {
      const actor = await actorFor(client, b.user.id);
      await showUpdateForm(client, opened.view!.id!, actor, topicId, name, { channelId: b.channel?.id });
    } catch (err) {
      await client.views.update({ view_id: opened.view!.id!, view: messageView('Update panelist', errorText(err)) });
    }
  });

  app.view(CB.update, async ({ ack, body, view, client }) => {
    const meta = parseMeta(view);
    const form = parseForm(view.state.values as never);
    const errors = await inlineErrors(form);
    if (Object.keys(errors).length) return void (await ack({ response_action: 'errors', errors }));
    await ack({ response_action: 'update', view: savingView() });
    const actor = await actorFor(client, body.user.id);
    try {
      const result = await service.updatePanelist(actor, {
        topicId: meta.topicId,
        name: meta.name ?? '',
        version: meta.version ?? '',
        changes: form.input as UserInput,
        note: form.notes,
      });
      await client.views.update({ view_id: view.id, view: messageView('Saved', `:white_check_mark: Updated *${result.panelist.name}*.\n${result.diff}`) });
      await reply(client, meta.channelId, body.user.id, `Updated ${result.panelist.name}`, writeSummaryBlocks('Updated', result));
    } catch (err) {
      if (err instanceof PanelError && err.data?.kind === 'conflict') {
        await showUpdateForm(client, view.id, actor, meta.topicId!, err.data.latest.data.name, meta, MESSAGES.CONFLICT);
        return;
      }
      if (isPanelError(err, 'NO_CHANGES')) {
        await client.views.update({ view_id: view.id, view: messageView('Nothing to save', MESSAGES.NO_CHANGES) });
        return;
      }
      const lists = await service.getLists();
      const fieldErrors = err instanceof PanelError && err.data?.kind === 'validation' ? Object.keys(err.data.errors) : [];
      await client.views.update({
        view_id: view.id,
        view: panelistForm({
          mode: 'update',
          lists,
          topic: meta.topicId ? service.topicById(meta.topicId) : undefined,
          initial: formInitial(form),
          meta,
          error: `Couldn't save${fieldErrors.length ? ` (${fieldErrors.map((f) => FIELD_LABELS[f as FieldKey]).join(', ')})` : ''}: ${errorText(err)} Your inputs are kept — fix and save again.`,
        }),
      });
    }
  });

  // ------------------------------------------------------------ undo (FR-6)

  app.action(ACTION.undo, async ({ ack, body, client, respond }) => {
    await ack();
    const b = body as { user: { id: string }; actions: { value?: string }[] };
    try {
      const actor = await actorFor(client, b.user.id);
      const { topic, name } = await service.undoWrite(actor, b.actions[0]?.value ?? '');
      await respond({ replace_original: true, text: `:leftwards_arrow_with_hook: Undone — *${name}* on *${topic.tabName}* is back to how it was.` });
    } catch (err) {
      await respond({ replace_original: false, response_type: 'ephemeral', text: errorText(err) });
    }
  });

  app.error(async (err) => {
    logger.error('bolt.error', errorFields(err));
  });
}
