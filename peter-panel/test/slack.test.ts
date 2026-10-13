import { describe, expect, it } from 'vitest';
import { defaultLists } from '../src/store/defaults.js';
import { listBlocks, statusText, writeSummaryBlocks } from '../src/slack/format.js';
import { decodeRef, encodeRef, parseAssign, parseCommand, parseForm, parseMeta } from '../src/slack/parse.js';
import { NONE, panelistForm, pickView } from '../src/slack/views.js';
import { emptyPanelist } from '../src/domain/types.js';
import { setup, topic, topics } from './helpers.js';

describe('command parsing', () => {
  it('splits subcommand and argument', () => {
    expect(parseCommand('update  Joe   J')).toEqual({ sub: 'update', rest: 'Joe J' });
    expect(parseCommand('PICK')).toEqual({ sub: 'pick', rest: '' });
    expect(parseCommand('')).toEqual({ sub: 'help', rest: '' });
    expect(parseCommand('dance')).toEqual({ sub: 'help', rest: 'dance' });
  });

  it('parses /panel assign with an escaped mention', () => {
    expect(parseAssign('<@U012ABC|gia> 3')).toEqual({ userId: 'U012ABC', topicText: '3' });
    expect(parseAssign('<@U012ABC> Air Time')).toEqual({ userId: 'U012ABC', topicText: 'Air Time' });
    expect(parseAssign('gia 3')).toBeNull();
    expect(parseAssign('<@U012ABC>')).toBeNull();
  });

  it('round-trips row references, including names with colons', () => {
    expect(decodeRef(encodeRef('money', 'Dr. A::B'))).toEqual({ topicId: 'money', name: 'Dr. A::B' });
  });

  it('tolerates bad private_metadata', () => {
    expect(parseMeta({ private_metadata: '{bad' })).toEqual({});
  });
});

describe('form parsing (Slack payload fixture)', () => {
  const values = {
    topic: { v: { type: 'static_select', selected_option: { value: 'grid' } } },
    name: { v: { type: 'plain_text_input', value: ' Joe J ' } },
    role: { v: { type: 'plain_text_input', value: null } },
    company: { v: { type: 'plain_text_input', value: 'Acme' } },
    alum: { v: { type: 'static_select', selected_option: null } },
    status: { v: { type: 'static_select', selected_option: { value: 'Interested' } } },
    panelB: { v: { type: 'static_select', selected_option: { value: NONE } } },
    notes: { v: { type: 'plain_text_input', value: 'hi' } },
  };

  it('reads text, selects and the (none) option', () => {
    const f = parseForm(values);
    expect(f.topicId).toBe('grid');
    expect(f.notes).toBe('hi');
    expect(f.input).toEqual({ name: 'Joe J', role: '', company: 'Acme', status: 'Interested', panelB: '' });
    // An untouched select is "no change", not "clear".
    expect(f.input).not.toHaveProperty('alum');
  });
});

describe('views', () => {
  it('pick lists only unclaimed panels', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const view = pickView(await service.unclaimedTopics(), {}) as any;
    const options = view.blocks.find((b: any) => b.block_id === 'topic').element.options.map((o: any) => o.value);
    expect(options).toHaveLength(14);
    expect(options).not.toContain('money');
  });

  it('owner add form has no panel picker; admin form does', () => {
    const lists = defaultLists(topics);
    const owner = panelistForm({ mode: 'add', lists, meta: {}, topic: topic('money') }) as any;
    const admin = panelistForm({ mode: 'add', lists, meta: {}, topics }) as any;
    expect(owner.blocks.some((b: any) => b.block_id === 'topic')).toBe(false);
    expect(admin.blocks.some((b: any) => b.block_id === 'topic')).toBe(true);
  });

  it('update form pre-fills values and labels notes "Add a note"', () => {
    const lists = defaultLists(topics);
    const view = panelistForm({
      mode: 'update',
      lists,
      meta: {},
      topic: topic('money'),
      initial: { ...emptyPanelist(), name: 'Joe J', status: 'Interested', notes: 'old note' },
    }) as any;
    const status = view.blocks.find((b: any) => b.block_id === 'status');
    expect(status.element.initial_option.value).toBe('Interested');
    expect(view.blocks.find((b: any) => b.block_id === 'notes').label.text).toBe('Add a note');
    expect(view.blocks.find((b: any) => b.block_id === 'notes').element.initial_value).toBeUndefined();
  });

  it('every modal fits Slack limits', () => {
    const lists = defaultLists(topics);
    const view = panelistForm({ mode: 'add', lists, meta: { channelId: 'C1' }, topics }) as any;
    expect(view.blocks.length).toBeLessThanOrEqual(100);
    expect(view.title.text.length).toBeLessThanOrEqual(24);
    expect(view.private_metadata.length).toBeLessThan(3000);
  });
});

describe('messages', () => {
  it('summary carries an Undo button', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const r = await service.addPanelist(await as('UKEANAN'), { name: 'Joe J' });
    const blocks = writeSummaryBlocks('Added', r) as any[];
    const undo = blocks[1].elements.find((e: any) => e.action_id === 'undo');
    expect(undo.value).toBe(r.undoId);
  });

  it('list groups by status with Update buttons and stays under the block limit', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const k = await as('UKEANAN');
    for (let i = 0; i < 60; i++) await service.addPanelist(k, { name: `Person ${i}`, status: i % 2 ? 'Interested' : 'Outreach 1 Sent' });
    const { topic: t, rows } = await service.listTopic(k);
    const blocks = listBlocks(t, rows, defaultLists(topics).status) as any[];
    expect(blocks.length).toBeLessThanOrEqual(50);
    expect(blocks.filter((b) => b.accessory?.action_id === 'open_update').length).toBeGreaterThan(10);
    expect(blocks.at(-1).elements[0].text).toMatch(/more/);
  });

  it('status table shows gaps and unpicked owners', async () => {
    const { service, as } = setup();
    await service.pick(await as('UKEANAN'), 'money');
    const { topics: ts, unpicked } = await service.status();
    const text = statusText(ts, unpicked);
    expect(text).toContain('Keanan Crasto');
    expect(text).toContain('Hasn’t picked a panel:* Gia Levatich');
    expect(text).toContain('No owner (leads cover these)');
  });
});
