import { describe, expect, it, vi } from 'vitest';
import {
  buildPrompt,
  ClaudeInterpreter,
  cleanInterpretation,
  interpretationSchema,
  MODEL,
  type Interpretation,
  type Interpreter,
} from '../src/ai/interpreter.js';
import { FreeTextPlanner, findRow } from '../src/service/FreeTextPlanner.js';
import { defaultLists } from '../src/store/defaults.js';
import { cleanSlackText, proposalBlocks } from '../src/slack/freeText.js';
import { setup, topic, topics } from './helpers.js';

const lists = defaultLists(topics);

function fakeInterpreter(result: Interpretation): Interpreter & { calls: unknown[] } {
  const calls: unknown[] = [];
  return { calls, interpret: async (input) => (calls.push(input), result) };
}

async function ownerWithRow() {
  const ctx = setup();
  await ctx.service.pick(await ctx.as('UKEANAN'), 'money');
  const keanan = await ctx.as('UKEANAN');
  await ctx.service.addPanelist(keanan, { name: 'Joe Johnson', company: 'Acme', status: 'Outreach 1 Sent' });
  return { ...ctx, keanan };
}

describe('interpreter', () => {
  it('builds a strict schema with the workbook dropdowns as enums', () => {
    const schema = interpretationSchema(lists, topics) as any;
    const item = schema.properties.panelists.items;
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(['name', 'topicId', 'changes', 'note']);
    expect(item.properties.changes.required).toEqual(Object.keys(item.properties.changes.properties));
    expect(item.properties.changes.properties.status.anyOf[0].enum).toContain('Interested');
    expect(item.properties.topicId.enum).toContain('money');
  });

  it('puts the author, panels and current panelists in the prompt', () => {
    const prompt = buildPrompt({
      text: 'talked to Joe',
      author: 'Keanan Crasto',
      panels: [{ topic: topic('money'), panelists: [{ name: 'Joe Johnson', status: 'Outreach 1 Sent', company: 'Acme', role: '' }] }],
      lists,
      today: '10/20',
    });
    expect(prompt).toContain('from Keanan Crasto');
    expect(prompt).toContain('topicId: money');
    expect(prompt).toContain('- Joe Johnson [Outreach 1 Sent] — Acme');
    expect(prompt).toContain('<message>\ntalked to Joe\n</message>');
  });

  it('drops nulls and blanks from the model output', () => {
    expect(
      cleanInterpretation({
        panelists: [
          { name: ' Joe ', topicId: 'money', changes: { status: 'Interested', company: null, role: '  ', bogus: 'x' } as any, note: ' hi ' },
          { name: '', topicId: '', changes: {}, note: '' },
        ],
        reply: '',
      }),
    ).toEqual({ panelists: [{ name: 'Joe', topicId: 'money', changes: { status: 'Interested' }, note: 'hi' }], reply: '' });
  });

  it('calls Claude with structured output and default refusal fallbacks', async () => {
    const create = vi.fn().mockResolvedValue({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ panelists: [{ name: 'Joe Johnson', topicId: 'money', changes: { status: 'Interested' }, note: '' }], reply: '' }) }],
    });
    const interp = new ClaudeInterpreter({ beta: { messages: { create } } } as any);
    const out = await interp.interpret({ text: 'Joe is keen', author: 'K', panels: [{ topic: topic('money'), panelists: [] }], lists, today: '10/20' });
    expect(out.panelists[0]).toMatchObject({ name: 'Joe Johnson', changes: { status: 'Interested' } });
    const req = create.mock.calls[0][0];
    expect(req).toMatchObject({ model: MODEL, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] });
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req).not.toHaveProperty('thinking');
  });

  it('turns a refusal into a friendly reply', async () => {
    const create = vi.fn().mockResolvedValue({ stop_reason: 'refusal', stop_details: { category: null }, content: [] });
    const out = await new ClaudeInterpreter({ beta: { messages: { create } } } as any).interpret({ text: 'x', author: 'K', panels: [], lists, today: '10/20' });
    expect(out.panelists).toEqual([]);
    expect(out.reply).toMatch(/\/panel update/);
  });
});

describe('planner', () => {
  it('matches a first name to the existing row and proposes only real changes', async () => {
    const { service, keanan } = await ownerWithRow();
    const interp = fakeInterpreter({
      panelists: [{ name: 'Joe', topicId: '', changes: { status: 'Interested', company: 'Acme', speakerType: 'Moderator' }, note: 'Receptive; mentioned their Texas pilot.' }],
      reply: '',
    });
    const plan = await new FreeTextPlanner(service, interp).plan(keanan, 'talked to Joe, receptive, wants to moderate');
    expect(plan.proposals).toHaveLength(1);
    const [p] = plan.proposals;
    expect(p).toMatchObject({ kind: 'update', topicId: 'money', name: 'Joe Johnson', changes: { status: 'Interested', speakerType: 'Moderator' } });
    expect(p.changes).not.toHaveProperty('company'); // already Acme
    expect(p.summary).toContain('Status: Outreach 1 Sent → Interested');
    expect(p.summary).toContain('Note: Receptive; mentioned their Texas pilot.');
    expect((interp.calls[0] as any).panels.map((x: any) => x.topic.id)).toEqual(['money']); // owners only see their panel
  });

  it('applies an update only when confirmed, with the note appended', async () => {
    const { service, store, keanan } = await ownerWithRow();
    const planner = new FreeTextPlanner(service, fakeInterpreter({ panelists: [{ name: 'Joe Johnson', topicId: 'money', changes: { status: 'Interested' }, note: 'Keen.' }], reply: '' }));
    const { proposals } = await planner.plan(keanan, 'Joe Johnson is keen');
    expect(store.tabs.get('Where the Money Blows')![0]!.status).toBe('Outreach 1 Sent'); // nothing written yet
    const { result } = await planner.apply(keanan, proposals[0].id);
    expect(result.panelist).toMatchObject({ status: 'Interested', notes: '10/13 (Keanan Crasto): Keen.' });
    expect(store.tracker[0]!.status).toBe('Interested');
    await expect(planner.apply(keanan, proposals[0].id)).rejects.toThrow(/expired/); // single use
  });

  it('proposes an add on the owner’s panel for someone new', async () => {
    const { service, store, keanan } = await ownerWithRow();
    const planner = new FreeTextPlanner(service, fakeInterpreter({ panelists: [{ name: 'Priya Shah', topicId: '', changes: { company: 'GridCo', status: 'Interested' }, note: 'Met at NYCW.' }], reply: '' }));
    const { proposals } = await planner.plan(keanan, 'met Priya Shah from GridCo, interested');
    expect(proposals[0]).toMatchObject({ kind: 'add', topicId: 'money', name: 'Priya Shah' });
    await planner.apply(keanan, proposals[0].id);
    expect(store.tabs.get('Where the Money Blows')![1]).toMatchObject({ name: 'Priya Shah', company: 'GridCo', status: 'Interested', notes: '10/13 (Keanan Crasto): Met at NYCW.' });
  });

  it('skips people with nothing new and passes the model’s reply through', async () => {
    const { service, keanan } = await ownerWithRow();
    const planner = new FreeTextPlanner(service, fakeInterpreter({ panelists: [{ name: 'Joe Johnson', topicId: 'money', changes: { status: 'Outreach 1 Sent' }, note: '' }], reply: '' }));
    const plan = await planner.plan(keanan, 'emailed Joe');
    expect(plan.proposals).toEqual([]);
    expect(plan.reply).toMatch(/already says that/);
    const q = new FreeTextPlanner(service, fakeInterpreter({ panelists: [], reply: 'Who did you talk to?' }));
    expect((await q.plan(keanan, 'had a good call')).reply).toBe('Who did you talk to?');
  });

  it('keeps permissions: no topic → pick first; others can’t apply your proposal', async () => {
    const { service, as, keanan } = await ownerWithRow();
    const gia = await as('UGIA');
    const interp = fakeInterpreter({ panelists: [{ name: 'X', topicId: '', changes: {}, note: 'hi' }], reply: '' });
    await expect(new FreeTextPlanner(service, interp).plan(gia, 'x')).rejects.toMatchObject({ code: 'NO_TOPIC' });
    const planner = new FreeTextPlanner(service, interp);
    const { proposals } = await planner.plan(keanan, 'x');
    await expect(planner.apply(gia, proposals[0].id)).rejects.toThrow(/Only the person/);
  });

  it('refuses a stale proposal if the row changed in the meantime', async () => {
    const { service, store, keanan } = await ownerWithRow();
    const planner = new FreeTextPlanner(service, fakeInterpreter({ panelists: [{ name: 'Joe Johnson', topicId: 'money', changes: { status: 'Interested' }, note: '' }], reply: '' }));
    const { proposals } = await planner.plan(keanan, 'Joe keen');
    store.tabs.get('Where the Money Blows')![0]!.company = 'Edited in the sheet';
    await expect(planner.apply(keanan, proposals[0].id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('leaves the panel open for a lead adding someone without saying where', async () => {
    const { service, as } = await ownerWithRow();
    const adi = await as('UADI');
    const planner = new FreeTextPlanner(service, fakeInterpreter({ panelists: [{ name: 'Sam Lee', topicId: '', changes: {}, note: 'Great fit.' }], reply: '' }));
    const { proposals } = await planner.plan(adi, 'Sam Lee would be great');
    expect(proposals[0].topicId).toBeUndefined();
    const actions = (proposalBlocks(proposals[0])[1] as any).elements.map((e: any) => e.action_id);
    expect(actions).toEqual(['ai_edit', 'ai_cancel']); // no Apply until a panel is chosen
  });

  it('matches names exactly first, then one unambiguous partial', () => {
    const rows = new Map([['money', [{ rowIndex: 0, data: { name: 'Joe Johnson' } }, { rowIndex: 1, data: { name: 'Joanna Lee' } }] as any]]);
    expect(findRow('joe  johnson', [topic('money')], rows)?.row.rowIndex).toBe(0);
    expect(findRow('Joe', [topic('money')], rows)?.row.rowIndex).toBe(0);
    expect(findRow('Jo', [topic('money')], rows)).toBeUndefined();
  });
});

describe('Slack text', () => {
  it('drops the bot mention and resolves people, channels and links', async () => {
    const out = await cleanSlackText(
      '<@UBOT> talked to Joe via <@UGIA|gia> in <#C1|kcc>, see <https://acme.com|Acme> &amp; more',
      'UBOT',
      async (id) => (id === 'UGIA' ? 'Gia Levatich' : id),
    );
    expect(out).toBe('talked to Joe via @Gia Levatich in #kcc, see Acme (https://acme.com) & more');
  });
});
