import { USER_FIELDS, type Panelist } from '../domain/types.js';
import type { UserInput } from '../service/PanelService.js';
import { NONE, V, type ModalMeta } from './views.js';

export type Subcommand =
  | 'pick'
  | 'add'
  | 'update'
  | 'list'
  | 'status'
  | 'find'
  | 'assign'
  | 'resync'
  | 'reload'
  | 'help';

const SUBCOMMANDS: Subcommand[] = ['pick', 'add', 'update', 'list', 'status', 'find', 'assign', 'resync', 'reload', 'help'];

/** Splits "/panel update Joe Smith" into { sub: 'update', rest: 'Joe Smith' }. Unknown → help. */
export function parseCommand(text: string): { sub: Subcommand; rest: string } {
  const trimmed = text.trim();
  const [first = '', ...rest] = trimmed.split(/\s+/);
  const sub = first.toLowerCase() as Subcommand;
  return SUBCOMMANDS.includes(sub) ? { sub, rest: rest.join(' ').trim() } : { sub: 'help', rest: trimmed };
}

/** Parses "<@U123ABC|adi> 3" or "<@U123ABC> Air Time" from /panel assign. */
export function parseAssign(rest: string): { userId: string; topicText: string } | null {
  const m = rest.match(/^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>\s*(.*)$/);
  return m && m[2].trim() ? { userId: m[1], topicText: m[2].trim() } : null;
}

/** Option values for update buttons and the external select: "<topicId>::<name>". */
export function encodeRef(topicId: string, name: string): string {
  return `${topicId}::${name}`.slice(0, 150);
}

export function decodeRef(value: string): { topicId: string; name: string } {
  const i = value.indexOf('::');
  return { topicId: value.slice(0, i), name: value.slice(i + 2) };
}

export function parseMeta(view: { private_metadata?: string }): ModalMeta {
  try {
    return view.private_metadata ? (JSON.parse(view.private_metadata) as ModalMeta) : {};
  } catch {
    return {};
  }
}

type StateValues = Record<string, Record<string, { type: string; value?: string | null; selected_option?: { value: string } | null }>>;

export interface ParsedForm {
  topicId?: string;
  /** Text inputs always present (blank = cleared); selects only when something is chosen. */
  input: UserInput;
  notes: string;
}

/** Reads the Add / Update form out of view.state.values. */
export function parseForm(values: StateValues): ParsedForm {
  const input: UserInput = {};
  for (const field of USER_FIELDS) {
    const el = values[field]?.[V];
    if (!el) continue;
    if (el.type === 'plain_text_input') input[field] = (el.value ?? '').trim();
    else if (el.selected_option) input[field] = el.selected_option.value === NONE ? '' : el.selected_option.value;
  }
  return {
    topicId: values.topic?.[V]?.selected_option?.value,
    input,
    notes: (values.notes?.[V]?.value ?? '').trim(),
  };
}

/** Values to re-show in a form after a failed save, so nothing typed is lost. */
export function formInitial(form: ParsedForm, base: Partial<Panelist> = {}): Partial<Panelist> {
  return { ...base, ...form.input };
}
