import type { KnownBlock, View, PlainTextOption } from '@slack/types';
import type { DropdownLists, Panelist, Topic } from '../domain/types.js';

export const CB = {
  pick: 'pick_modal',
  add: 'add_modal',
  updateSelect: 'update_select_modal',
  update: 'update_modal',
  duplicate: 'duplicate_modal',
} as const;

export const ACTION = {
  openPick: 'open_pick',
  openUpdate: 'open_update',
  updatePick: 'update_pick',
  undo: 'undo',
} as const;

/** Single action_id used for every form input; the block_id names the field. */
export const V = 'v';
export const NONE = '__none__';

export interface ModalMeta {
  channelId?: string;
  topicId?: string;
  name?: string;
  version?: string;
  pendingId?: string;
}

const text = (t: string) => ({ type: 'plain_text' as const, text: t.slice(0, 75), emoji: true });
const md = (t: string) => ({ type: 'mrkdwn' as const, text: t.slice(0, 3000) });

function option(value: string, label = value): PlainTextOption {
  return { text: text(label || value), value: value.slice(0, 150) };
}

const topicOption = (t: Topic) => option(t.id, `${t.number}. ${t.panel}`);

function modal(callbackId: string, title: string, blocks: KnownBlock[], meta: ModalMeta = {}, submit?: string): View {
  return {
    type: 'modal',
    callback_id: callbackId,
    title: text(title.slice(0, 24)),
    close: text(submit ? 'Cancel' : 'Close'),
    ...(submit ? { submit: text(submit) } : {}),
    private_metadata: JSON.stringify(meta),
    blocks,
  };
}

function banner(message?: string): KnownBlock[] {
  return message ? [{ type: 'section', text: md(`:warning: ${message}`) }, { type: 'divider' }] : [];
}

function textInput(field: string, label: string, opts: { initial?: string; optional?: boolean; multiline?: boolean; hint?: string } = {}): KnownBlock {
  return {
    type: 'input',
    block_id: field,
    optional: opts.optional ?? true,
    label: text(label),
    ...(opts.hint ? { hint: text(opts.hint) } : {}),
    element: {
      type: 'plain_text_input',
      action_id: V,
      multiline: opts.multiline ?? false,
      ...(opts.initial ? { initial_value: opts.initial } : {}),
    },
  };
}

function selectInput(field: string, label: string, values: string[], opts: { initial?: string; optional?: boolean; allowNone?: boolean } = {}): KnownBlock {
  const options = [...(opts.allowNone ? [option(NONE, '(none)')] : []), ...values.slice(0, 100).map((v) => option(v))];
  const initial = options.find((o) => o.value === opts.initial);
  return {
    type: 'input',
    block_id: field,
    optional: opts.optional ?? true,
    label: text(label),
    element: {
      type: 'static_select',
      action_id: V,
      placeholder: text('Choose…'),
      options,
      ...(initial ? { initial_option: initial } : {}),
    },
  };
}

export function loadingView(title = 'Peter Panel', message = 'Loading…'): View {
  return modal('loading', title, [{ type: 'section', text: md(`:hourglass_flowing_sand: ${message}`) }]);
}

export function savingView(): View {
  return loadingView('Saving', 'Saving to the tracker…');
}

export function messageView(title: string, message: string): View {
  return modal('message', title, [{ type: 'section', text: md(message) }]);
}

/** FR-0: choose one of the unclaimed panels. */
export function pickView(unclaimed: Topic[], meta: ModalMeta, error?: string): View {
  if (!unclaimed.length) return messageView('Pick your panel', 'Every panel has an owner. Ask a programming lead.');
  return modal(
    CB.pick,
    'Pick your panel',
    [
      ...banner(error),
      { type: 'section', text: md('Pick the panel you own. You can only pick one; a lead can change it later.') },
      {
        type: 'input',
        block_id: 'topic',
        label: text('Panel'),
        element: {
          type: 'static_select',
          action_id: V,
          placeholder: text('Choose a panel'),
          options: unclaimed.map(topicOption),
        },
      },
      { type: 'context', elements: [md(unclaimed.map((t) => `*${t.number}. ${t.panel}* — ${t.focus}`).join('\n'))] },
    ],
    meta,
    'Pick',
  );
}

export interface FormOptions {
  mode: 'add' | 'update';
  lists: DropdownLists;
  meta: ModalMeta;
  initial?: Partial<Panelist>;
  /** Admins choose a panel when adding; owners never do. */
  topics?: Topic[];
  topic?: Topic;
  error?: string;
}

/** FR-1 / FR-3: the Add and Update panelist form. */
export function panelistForm(o: FormOptions): View {
  const i = o.initial ?? {};
  const blocks: KnownBlock[] = [...banner(o.error)];
  if (o.mode === 'add' && o.topics) {
    const selected = o.topics.find((t) => t.id === o.meta.topicId);
    blocks.push({
      type: 'input',
      block_id: 'topic',
      label: text('Panel'),
      element: {
        type: 'static_select',
        action_id: V,
        placeholder: text('Choose a panel'),
        options: o.topics.map(topicOption),
        ...(selected ? { initial_option: topicOption(selected) } : {}),
      },
    });
  } else if (o.topic) {
    blocks.push({ type: 'context', elements: [md(`Panel: *${o.topic.panel}*`)] });
  }
  blocks.push(
    textInput('name', 'Name', { initial: i.name, optional: false }),
    textInput('role', 'Role/Title', { initial: i.role }),
    textInput('company', 'Company', { initial: i.company }),
    selectInput('alum', 'Kellogg Alum?', o.lists.alum, { initial: i.alum }),
    selectInput('speakerType', 'Speaker Type', o.lists.speakerType, { initial: i.speakerType }),
    selectInput('priority', 'Priority', o.lists.priority, { initial: i.priority }),
    selectInput('status', 'Outreach Status', o.lists.status, { initial: i.status ?? (o.mode === 'add' ? 'Potential Outreach' : undefined) }),
    textInput('description', 'Speaker Description', { initial: i.description, multiline: true }),
    selectInput('panelB', 'Other panel (option B)', o.lists.panelB, { initial: i.panelB, allowNone: true }),
    textInput('location', 'Location', { initial: i.location }),
    textInput('connection', 'Connection', { initial: i.connection, hint: 'Who on the team knows them' }),
    textInput('notes', o.mode === 'add' ? 'Notes' : 'Add a note', {
      multiline: true,
      hint: o.mode === 'update' ? 'Added below earlier notes with today’s date and your name.' : undefined,
    }),
  );
  if (o.mode === 'update' && i.notes) {
    blocks.push({ type: 'context', elements: [md(`*Earlier notes*\n${i.notes.slice(-2500)}`)] });
  }
  return modal(o.mode === 'add' ? CB.add : CB.update, o.mode === 'add' ? 'Add panelist' : 'Update panelist', blocks, o.meta, 'Save');
}

/** FR-3 step 1: searchable select of names (external, so it scales past 100). */
export function updateSelectView(meta: ModalMeta, error?: string): View {
  return modal(CB.updateSelect, 'Update panelist', [
    ...banner(error),
    {
      type: 'section',
      block_id: 'pick',
      text: md('Who are you updating?'),
      accessory: {
        type: 'external_select',
        action_id: ACTION.updatePick,
        placeholder: text('Start typing a name'),
        min_query_length: 0,
      },
    },
  ], meta);
}

/** FR-2: duplicate warning with Add anyway / Cancel. */
export function duplicateView(lines: string[], meta: ModalMeta): View {
  return modal(CB.duplicate, 'Possible duplicate', [{ type: 'section', text: md(lines.join('\n')) }], meta, 'Add anyway');
}
