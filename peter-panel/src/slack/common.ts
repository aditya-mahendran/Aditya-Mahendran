import type { KnownBlock } from '@slack/types';
import type { WebClient } from '@slack/web-api';
import type { TeamMember } from '../domain/types.js';
import { errorFields, logger } from '../logger.js';
import { isPanelError, PanelError } from '../service/errors.js';
import type { PanelService } from '../service/PanelService.js';

/** Who is calling. Team rows without a Slack ID are bound by real name on first use. */
export function makeActorFor(service: PanelService) {
  return async function actorFor(client: WebClient, userId: string): Promise<TeamMember> {
    try {
      return await service.identify(userId);
    } catch (err) {
      if (!isPanelError(err, 'NOT_ON_TEAM')) throw err;
      const info = await client.users.info({ user: userId }).catch(() => null);
      const profile = info?.user;
      return service.identify(userId, { realName: profile?.real_name ?? profile?.profile?.real_name, displayName: profile?.profile?.display_name });
    }
  };
}

/** Ephemeral reply in the channel (in a thread if given); falls back to a DM when the bot can't post there. */
export async function reply(
  client: WebClient,
  channelId: string | undefined,
  userId: string,
  text: string,
  blocks?: KnownBlock[],
  threadTs?: string,
) {
  if (channelId) {
    try {
      await client.chat.postEphemeral({ channel: channelId, user: userId, text, blocks, ...(threadTs ? { thread_ts: threadTs } : {}) });
      return;
    } catch (err) {
      logger.debug('reply.ephemeral_failed', errorFields(err));
    }
  }
  await client.chat.postMessage({ channel: userId, text, blocks });
}

export function errorText(err: unknown): string {
  if (err instanceof PanelError) return err.message;
  logger.error('unexpected', errorFields(err));
  return `Something went wrong talking to the tracker: ${(err as Error).message}`;
}
