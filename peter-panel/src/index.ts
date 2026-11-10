import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { loadConfig, loadTopics } from './config.js';
import { startScheduler } from './jobs/scheduler.js';
import { errorFields, logger } from './logger.js';
import { PanelService } from './service/PanelService.js';
import { ClaudeInterpreter } from './ai/interpreter.js';
import { FreeTextPlanner } from './service/FreeTextPlanner.js';
import { registerFreeText } from './slack/freeText.js';
import { registerHandlers } from './slack/handlers.js';
import { slackNotifier } from './slack/notifier.js';
import { createStore } from './store/createStore.js';

process.env.TZ ??= 'America/Chicago';

async function main() {
  const cfg = loadConfig();
  const topics = loadTopics();
  const socketMode = !!cfg.slack.appToken;

  const app = new App({
    token: cfg.slack.botToken,
    ...(socketMode
      ? { socketMode: true, appToken: cfg.slack.appToken }
      : { signingSecret: cfg.slack.signingSecret, port: cfg.slack.port }),
    logLevel: process.env.DEBUG ? LogLevel.DEBUG : LogLevel.WARN,
  });

  const store = createStore(cfg, topics);
  await store.check?.();
  const service = new PanelService(store, topics, {
    notifier: slackNotifier(app.client, cfg.notifyChannelId),
  });
  // Load Team and dropdown lists up front so the first modal opens fast.
  const loaded = await service.reload();
  logger.info('config.loaded', { topics: topics.length, team: loaded.team });

  registerHandlers(app, service);
  // FR-9: "@Peter Panel talked to …" in a channel or DM, read by Claude, confirmed by the author.
  const planner = process.env.ANTHROPIC_API_KEY ? new FreeTextPlanner(service, new ClaudeInterpreter()) : null;
  // FREE_TEXT_MODE=confirm makes people click Apply first; default saves straight away with Undo.
  registerFreeText(app, service, planner, process.env.FREE_TEXT_MODE === 'confirm' ? 'confirm' : 'auto');
  if (!planner) logger.warn('freetext.disabled', { reason: 'ANTHROPIC_API_KEY not set' });

  await app.start(cfg.slack.port);
  logger.info('app.started', { mode: socketMode ? 'socket' : 'http', store: cfg.store });

  // Peter Panel's own user ID, so the weekly check-in can show "@Peter Panel" as a real mention.
  let botUserId: string | undefined;
  void app.client.auth
    .test()
    .then((r) => (botUserId = r.user_id))
    .catch(() => undefined);
  const stopScheduler = startScheduler(service, app.client, {
    channelId: cfg.notifyChannelId,
    remindersEnabled: cfg.remindersEnabled,
    // Sunday check-in in the channel. WEEKLY_CHECKIN_CRON=off turns it off.
    checkInCron: process.env.WEEKLY_CHECKIN_CRON === 'off' ? null : process.env.WEEKLY_CHECKIN_CRON || undefined,
    botUserId: () => botUserId,
  });

  const shutdown = async (signal: string) => {
    logger.info('app.stopping', { signal });
    stopScheduler();
    await service.settle().catch(() => undefined);
    await store.close?.();
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error('app.crashed', errorFields(err));
  process.exit(1);
});
