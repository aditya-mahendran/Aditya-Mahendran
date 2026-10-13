import 'dotenv/config';
import { App, LogLevel } from '@slack/bolt';
import { loadConfig, loadTopics } from './config.js';
import { startScheduler } from './jobs/scheduler.js';
import { errorFields, logger } from './logger.js';
import { PanelService } from './service/PanelService.js';
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
  const service = new PanelService(store, topics, {
    notifier: slackNotifier(app.client, cfg.notifyChannelId),
  });
  // Load Team and dropdown lists up front so the first modal opens fast.
  const loaded = await service.reload();
  logger.info('config.loaded', { topics: topics.length, team: loaded.team });

  registerHandlers(app, service);
  const stopScheduler = startScheduler(service, app.client, {
    channelId: cfg.notifyChannelId,
    remindersEnabled: cfg.remindersEnabled,
  });

  await app.start(cfg.slack.port);
  logger.info('app.started', { mode: socketMode ? 'socket' : 'http', store: cfg.store });

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
