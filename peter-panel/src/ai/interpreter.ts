import Anthropic from '@anthropic-ai/sdk';
import type { DropdownLists, Panelist, Topic } from '../domain/types.js';
import { logger } from '../logger.js';

/** Fields Claude may propose changing. Name is the row key; notes go in `note`. */
export const AI_FIELDS = [
  'status',
  'role',
  'company',
  'alum',
  'speakerType',
  'priority',
  'description',
  'panelB',
  'location',
  'connection',
] as const;
export type AiField = (typeof AI_FIELDS)[number];

export interface ProposedPanelist {
  /** Exact name from the tracker when updating someone known; full name otherwise. */
  name: string;
  /** Topic id the person belongs to, or '' if unknown. */
  topicId: string;
  /** Only the fields to change; absent = leave as is. */
  changes: Partial<Record<AiField, string>>;
  /** Short note to append, in the author's words. */
  note: string;
}

export interface Interpretation {
  panelists: ProposedPanelist[];
  /** Shown to the author when nothing could be extracted (e.g. a clarifying question). */
  reply: string;
}

export interface InterpretInput {
  text: string;
  author: string;
  /** Panels the author may write to, each with its current panelists. */
  panels: { topic: Topic; panelists: Pick<Panelist, 'name' | 'status' | 'company' | 'role'>[] }[];
  lists: DropdownLists;
  today: string;
}

/** Turns a free-text update into proposed tracker changes. Nothing is written here. */
export interface Interpreter {
  interpret(input: InterpretInput): Promise<Interpretation>;
}

export const MODEL = 'claude-opus-5-5';

const SYSTEM = `You turn short Slack messages from the Kellogg Climate Conference (KCC) 2026 programming team into updates for their panelist outreach tracker.

Each message is from one team member about people they are recruiting as panelists or moderators. Extract every person the message is about and what should change on their tracker row.

How to fill in each person:
- name: if the person is already on one of the listed panels, copy their name exactly as listed (match nicknames, first names or small misspellings to the right person when it's clearly them). Otherwise use the fullest name the message gives.
- topicId: the id of the panel they are on, or the panel the message clearly says they're for. If the author has exactly one panel, use it. Use "" if you can't tell.
- changes: set only fields the message actually tells you about; null for everything else. Never guess a value that isn't supported by the message.
  - status: pick the closest allowed value for where outreach now stands. "seemed receptive", "keen", "open to it", "wants to do it but needs to check dates" → Interested. "said yes", "locked in", "confirmed" → Confirmed. "sent the first email" → Outreach 1 Sent; "followed up" → Outreach 2 Sent. "set up a call / meeting" → Meeting Scheduled. "sent the formal invite" → Formal Invite Sent. "no reply after following up" → Unresponsive. "said no" → Declined; "can't make the date" → Declined - Unavailable or Unavailable. Leave null when the message doesn't say where things stand.
  - speakerType: Moderator only if they'd moderate; Panelist if they'd speak.
  - role, company, location, connection, alum, priority, description, panelB: only when stated. connection = who on the team knows them.
- note: one or two plain sentences with what the author learned, close to their own words (e.g. "Receptive on the call; mentioned their new grid-storage pilot in Texas."). Don't repeat facts already captured as field changes, and don't add the date or author — the app adds those. Use "" if there's nothing else worth noting.

If the message isn't about a specific person (a question, chit-chat, unclear who), return no panelists and put a short, friendly reply in "reply" — for example asking who they talked to. Otherwise "reply" is "".`;

function nullable(schema: Record<string, unknown>) {
  return { anyOf: [schema, { type: 'null' }] };
}

/** JSON schema for the response, with the workbook's own dropdown values as enums. */
export function interpretationSchema(lists: DropdownLists, topics: Topic[]) {
  const text = nullable({ type: 'string' });
  const pick = (values: string[]) => (values.length ? nullable({ type: 'string', enum: values }) : text);
  const changes = {
    status: pick(lists.status),
    role: text,
    company: text,
    alum: pick(lists.alum),
    speakerType: pick(lists.speakerType),
    priority: pick(lists.priority),
    description: text,
    panelB: pick(lists.panelB),
    location: text,
    connection: text,
  } satisfies Record<AiField, unknown>;
  return {
    type: 'object',
    additionalProperties: false,
    required: ['panelists', 'reply'],
    properties: {
      panelists: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'topicId', 'changes', 'note'],
          properties: {
            name: { type: 'string' },
            topicId: { type: 'string', enum: ['', ...topics.map((t) => t.id)] },
            changes: { type: 'object', additionalProperties: false, required: [...AI_FIELDS], properties: changes },
            note: { type: 'string' },
          },
        },
      },
      reply: { type: 'string' },
    },
  };
}

export function buildPrompt(input: InterpretInput): string {
  const panels = input.panels
    .map((p) => {
      const people = p.panelists.length
        ? p.panelists.map((x) => `  - ${x.name}${x.status ? ` [${x.status}]` : ''}${[x.role, x.company].filter(Boolean).length ? ` — ${[x.role, x.company].filter(Boolean).join(', ')}` : ''}`).join('\n')
        : '  (no panelists yet)';
      return `Panel "${p.topic.panel}" (topicId: ${p.topic.id}; focus: ${p.topic.focus})\n${people}`;
    })
    .join('\n\n');
  return `Today is ${input.today}. The message is from ${input.author}.

Panels ${input.author} can update, with who is already on each:

${panels}

<message>
${input.text}
</message>`;
}

/** Strips nulls and blanks so only real changes remain. */
export function cleanInterpretation(raw: {
  panelists?: { name?: string; topicId?: string; changes?: Record<string, string | null>; note?: string }[];
  reply?: string;
}): Interpretation {
  const panelists = (raw.panelists ?? [])
    .filter((p) => p.name?.trim())
    .map((p) => ({
      name: p.name!.trim(),
      topicId: p.topicId ?? '',
      changes: Object.fromEntries(
        Object.entries(p.changes ?? {}).filter(
          ([k, v]) => (AI_FIELDS as readonly string[]).includes(k) && typeof v === 'string' && v.trim(),
        ),
      ) as ProposedPanelist['changes'],
      note: (p.note ?? '').trim(),
    }));
  return { panelists, reply: (raw.reply ?? '').trim() };
}

/** Claude-backed interpreter. Uses structured output so the reply always parses. */
export class ClaudeInterpreter implements Interpreter {
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async interpret(input: InterpretInput): Promise<Interpretation> {
    const response = await this.client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      // A refusal is re-run server-side on Anthropic's recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: {
        effort: 'low', // short extraction; keeps replies quick in Slack
        format: { type: 'json_schema', schema: interpretationSchema(input.lists, input.panels.map((p) => p.topic)) },
      },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(input) }],
    });
    if (response.stop_reason === 'refusal') {
      logger.warn('ai.refusal', { category: response.stop_details?.category ?? null });
      return { panelists: [], reply: "I couldn't process that one. Try `/panel update` instead." };
    }
    if (response.stop_reason === 'max_tokens') {
      return { panelists: [], reply: 'That message was too long for me to process. Try splitting it up.' };
    }
    const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return cleanInterpretation(JSON.parse(text));
  }
}
