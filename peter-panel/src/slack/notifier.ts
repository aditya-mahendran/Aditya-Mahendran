import type { WebClient } from '@slack/web-api';
import { errorFields, logger } from '../logger.js';
import type { Notifier } from '../service/PanelService.js';

/** FR-7: posts one line to the configured channel. Never throws. */
export function slackNotifier(client: WebClient, channelId: string | undefined): Notifier {
  return {
    async notify(text) {
      if (!channelId) {
        logger.info('notify.skipped', { reason: 'NOTIFY_CHANNEL_ID not set' });
        return;
      }
      try {
        await client.chat.postMessage({ channel: channelId, text });
      } catch (err) {
        logger.error('notify.failed', errorFields(err));
      }
    },
  };
}
