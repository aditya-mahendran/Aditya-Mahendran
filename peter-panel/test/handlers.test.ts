import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { App } from '@slack/bolt';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerHandlers } from '../src/slack/handlers.js';
import { setup } from './helpers.js';

/** A local stand-in for slack.com/api and response_url, recording every call. */
let server: Server;
let base = '';
let calls: { path: string; body: any }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: any = raw;
      try {
        body = JSON.parse(raw);
      } catch {
        body = Object.fromEntries(new URLSearchParams(raw));
        for (const k of ['view', 'blocks']) if (typeof body[k] === 'string') body[k] = JSON.parse(body[k]);
      }
      calls.push({ path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      const user = body.user === 'UALEX' ? { real_name: 'Alex Nobel' } : { real_name: 'Somebody Else' };
      res.end(JSON.stringify({ ok: true, view: { id: 'V1' }, user }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function makeApp() {
  const ctx = setup();
  const app = new App({
    receiver: { init() {}, start: async () => undefined, stop: async () => undefined } as never,
    authorize: async () => ({ botToken: 'xoxb-test', botId: 'B1', botUserId: 'UBOT' }),
    clientOptions: { slackApiUrl: `${base}/api/` },
  });
  registerHandlers(app, ctx.service);
  return { app, ...ctx };
}

async function run(app: App, body: Record<string, unknown>) {
  let acked: unknown;
  await app.processEvent({ body, ack: async (r?: unknown) => void (acked = r) });
  // Handlers keep working after ack(); let them finish.
  await new Promise((r) => setTimeout(r, 50));
  return acked;
}

const command = (text: string, user_id: string) => ({
  command: '/panel',
  text,
  user_id,
  channel_id: 'C1',
  team_id: 'T1',
  trigger_id: 'trig',
  response_url: `${base}/respond`,
});

const responses = () => calls.filter((c) => c.path === '/respond').map((c) => c.body.text);
const api = (method: string) => calls.filter((c) => c.path === `/api/${method}`);

beforeEach(() => {
  calls = [];
});

describe('Slack handlers', () => {
  it('tells an unmapped user they are not on the team, and writes nothing', async () => {
    const { app, store } = makeApp();
    await run(app, command('add', 'USTRANGER'));
    expect(responses()).toEqual(["You're not on the programming team list — ask a programming lead."]);
    expect(store.log).toHaveLength(0);
  });

  it('replies "Pick your topic first" with a Pick button before picking', async () => {
    const { app } = makeApp();
    await run(app, command('add', 'UKEANAN'));
    const reply = calls.find((c) => c.path === '/respond')!.body;
    expect(reply.text).toBe('Pick your topic first.');
    expect(reply.blocks[0].accessory.action_id).toBe('open_pick');
  });

  it('runs pick → add end to end, ending in an ephemeral summary with Undo', async () => {
    const { app, store } = makeApp();
    await run(app, command('pick', 'UKEANAN'));
    const pickView = api('views.open')[0].body.view;
    expect(pickView.callback_id).toBe('pick_modal');

    await run(app, {
      type: 'view_submission',
      team: { id: 'T1' },
      user: { id: 'UKEANAN' },
      view: { id: 'V1', callback_id: 'pick_modal', private_metadata: pickView.private_metadata, state: { values: { topic: { v: { type: 'static_select', selected_option: { value: 'grid' } } } } } },
    });
    expect(store.tabs.has('Second Wind for the Grid')).toBe(true);

    await run(app, command('add', 'UKEANAN'));
    const addView = api('views.open').at(-1)!.body.view;
    expect(addView.callback_id).toBe('add_modal');

    const acked = await run(app, {
      type: 'view_submission',
      team: { id: 'T1' },
      user: { id: 'UKEANAN' },
      view: {
        id: 'V1',
        callback_id: 'add_modal',
        private_metadata: addView.private_metadata,
        state: { values: { name: { v: { type: 'plain_text_input', value: 'Joe J' } }, status: { v: { type: 'static_select', selected_option: { value: 'Potential Outreach' } } } } },
      },
    });
    expect(acked).toMatchObject({ response_action: 'update' });
    expect(store.tabs.get('Second Wind for the Grid')![0]?.name).toBe('Joe J');
    expect(store.tracker[0]?.name).toBe('Joe J');
    const eph = api('chat.postEphemeral').at(-1)!.body;
    expect(eph.channel).toBe('C1');
    expect(eph.blocks[1].elements[0].action_id).toBe('undo');
  });

  it('shows a missing name inline on the field', async () => {
    const { app, service, as } = makeApp();
    await service.pick(await as('UKEANAN'), 'grid');
    const acked = await run(app, {
      type: 'view_submission',
      team: { id: 'T1' },
      user: { id: 'UKEANAN' },
      view: { id: 'V1', callback_id: 'add_modal', private_metadata: '{}', state: { values: { name: { v: { type: 'plain_text_input', value: '  ' } } } } },
    });
    expect(acked).toEqual({ response_action: 'errors', errors: { name: 'Name is required.' } });
  });

  it('binds a Team row by Slack real name on first use', async () => {
    const { app, store } = makeApp();
    await run(app, command('pick', 'UALEX'));
    expect(store.team.find((m) => m.name === 'Alex Nobel')?.slackId).toBe('UALEX');
    expect(api('views.open')).toHaveLength(1);
  });

  it('keeps lead commands from owners', async () => {
    const { app } = makeApp();
    await run(app, command('status', 'UKEANAN'));
    expect(responses()).toEqual(['Only programming leads can do that.']);
  });

  it('lets a lead assign a panel', async () => {
    const { app, store } = makeApp();
    await run(app, command('assign <@UGIA|gia> 13', 'UADI'));
    expect(store.team.find((m) => m.slackId === 'UGIA')?.topic).toBe('In the Eye of the Storm');
    expect(responses().at(-1)).toContain('Gia Levatich now owns *In the Eye of the Storm*');
  });
});
