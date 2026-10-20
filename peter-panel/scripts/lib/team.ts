import { LogLevel, WebClient, type WebClientOptions } from '@slack/web-api';
import { loadTeamSeed } from '../../src/config.js';
import { normalizeName } from '../../src/domain/normalize.js';

export const TEAM_HEADER = ['Slack User ID', 'Name', 'Role', 'Topic'];

/** Slack user IDs by normalized real / display name, via users.list. Empty without SLACK_BOT_TOKEN. */
export async function slackIdsByName(clientOptions: WebClientOptions = {}): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  if (!process.env.SLACK_BOT_TOKEN || process.argv.includes('--skip-slack-ids')) return ids;
  // Large workspaces hit users.list rate limits; give up rather than wait, since the
  // app binds Team rows to Slack users by name on first use anyway.
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN, { rejectRateLimitedCalls: true, logLevel: LogLevel.ERROR, ...clientOptions });
  try {
    for await (const page of slack.paginate('users.list', { limit: 1000 })) {
      for (const u of (page as { members?: { id: string; deleted?: boolean; is_bot?: boolean; real_name?: string; profile?: { real_name?: string; display_name?: string } }[] }).members ?? []) {
        if (u.deleted || u.is_bot) continue;
        for (const n of [u.real_name, u.profile?.real_name, u.profile?.display_name]) if (n?.trim()) ids.set(normalizeName(n), u.id);
      }
    }
  } catch (err) {
    console.log(`  ! Skipped Slack ID lookup (${(err as Error).message}). People are matched by name the first time they use /panel.`);
    ids.clear();
  }
  return ids;
}

/**
 * Merges config/team.json into the Team tab's existing rows (kept as they are),
 * filling in missing Slack IDs. Returns the data rows, without the header.
 */
export async function mergeTeam(existing: string[][]): Promise<string[][]> {
  const rows = existing.map((r) => [...r, '', '', '', ''].slice(0, 4));
  const ids = await slackIdsByName();
  for (const seed of loadTeamSeed()) {
    let row = rows.find((r) => normalizeName(r[1] ?? '') === normalizeName(seed.name));
    if (!row) rows.push((row = ['', seed.name, seed.role, '']));
    if (!row[0]) {
      const id = ids.get(normalizeName(seed.name));
      if (id) row[0] = id;
      else if (ids.size) console.log(`  ! No Slack user found for ${seed.name}; they'll be matched by name on first use.`);
    }
  }
  return rows;
}
