import cron from 'node-cron';
import type { WebClient } from '@slack/web-api';
import { TZ } from '../domain/time.js';
import { errorFields, logger } from '../logger.js';
import type { PanelService } from '../service/PanelService.js';
import { reminderBlocks, statusText, weeklyCheckInBlocks } from '../slack/format.js';

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

/** Posts the weekly check-in to the channel, asking owners for this week's outreach updates. */
export async function sendWeeklyCheckIn(service: PanelService, client: WebClient, channelId: string, botUserId?: string) {
  const { topics } = await service.status();
  await client.chat.postMessage({ channel: channelId, text: 'Weekly panel check-in — any updates on outreach this week?', blocks: weeklyCheckInBlocks(topics, botUserId) });
  logger.info('checkin.posted', { channel: channelId });
}

export const DEFAULT_CHECKIN_CRON = '45 16 * * 0'; // Sundays 4:45pm Chicago time

export function startScheduler(
  service: PanelService,
  client: WebClient,
  opts: { channelId?: string; remindersEnabled: boolean; checkInCron?: string | null; botUserId?: () => string | undefined },
) {
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
  const checkInCron = opts.checkInCron === undefined ? DEFAULT_CHECKIN_CRON : opts.checkInCron;
  if (checkInCron && opts.channelId) {
    if (!cron.validate(checkInCron)) throw new Error(`WEEKLY_CHECKIN_CRON "${checkInCron}" is not a valid cron expression`);
    const channelId = opts.channelId;
    tasks.push(
      cron.schedule(
        checkInCron,
        () => void sendWeeklyCheckIn(service, client, channelId, opts.botUserId?.()).catch((err) => logger.error('checkin.failed', errorFields(err))),
        { timezone: TZ },
      ),
    );
  } else if (checkInCron) {
    logger.warn('checkin.disabled', { reason: 'NOTIFY_CHANNEL_ID not set' });
  }
  logger.info('scheduler.started', { reminders: opts.remindersEnabled, weeklyCheckIn: checkInCron && opts.channelId ? checkInCron : 'off' });
  return () => tasks.forEach((t) => t.stop());
}
