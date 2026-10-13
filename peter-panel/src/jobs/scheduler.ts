import cron from 'node-cron';
import type { WebClient } from '@slack/web-api';
import { TZ } from '../domain/time.js';
import { errorFields, logger } from '../logger.js';
import type { PanelService } from '../service/PanelService.js';
import { reminderBlocks, statusText } from '../slack/format.js';

/** Sends FR-8: a Monday DM to each owner and the /panel status digest to the channel. */
export async function sendWeeklyReminders(service: PanelService, client: WebClient, channelId?: string) {
  for (const d of await service.reminders()) {
    try {
      await client.chat.postMessage({ channel: d.owner.slackId, text: `Weekly check-in for ${d.topic.panel}`, blocks: reminderBlocks(d) });
    } catch (err) {
      logger.error('reminder.failed', { owner: d.owner.name, ...errorFields(err) });
    }
  }
  if (channelId) {
    const { topics, unpicked } = await service.status();
    await client.chat.postMessage({ channel: channelId, text: statusText(topics, unpicked) });
  }
}

export function startScheduler(service: PanelService, client: WebClient, opts: { channelId?: string; remindersEnabled: boolean }) {
  const tasks = [
    // FR-10: pick up edits made directly in Excel, nightly at 2:00 Chicago time.
    cron.schedule(
      '0 2 * * *',
      () => void service.resync().catch((err) => logger.error('resync.failed', errorFields(err))),
      { timezone: TZ },
    ),
  ];
  if (opts.remindersEnabled) {
    tasks.push(
      cron.schedule(
        '0 9 * * 1',
        () => void sendWeeklyReminders(service, client, opts.channelId).catch((err) => logger.error('reminders.failed', errorFields(err))),
        { timezone: TZ },
      ),
    );
  }
  logger.info('scheduler.started', { reminders: opts.remindersEnabled });
  return () => tasks.forEach((t) => t.stop());
}
