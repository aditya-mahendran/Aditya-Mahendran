import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { Role, Topic } from './domain/types.js';
import { parseSheetId, type GoogleConfig } from './store/sheets/googleAuth.js';

const here = dirname(fileURLToPath(import.meta.url));
/** Project root, whether running from src/ (tsx) or dist/src/ (built). */
export const ROOT = [resolve(here, '..'), resolve(here, '../..')].find((p) => existsSync(resolve(p, 'config/topics.json')))!;

export function loadTopics(path = resolve(ROOT, 'config/topics.json')): Topic[] {
  const { topics } = JSON.parse(readFileSync(path, 'utf8')) as { topics: Topic[] };
  const ids = new Set<string>();
  for (const t of topics) {
    if (ids.has(t.id)) throw new Error(`Duplicate topic id ${t.id} in topics.json`);
    ids.add(t.id);
    if (t.tabName.length > 31 || /[?*:/\\[\]]/.test(t.tabName)) {
      throw new Error(`Tab name "${t.tabName}" is not a valid Excel sheet name`);
    }
  }
  return topics;
}

export function loadTeamSeed(path = resolve(ROOT, 'config/team.json')): { name: string; role: Role }[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { team: { name: string; role: Role }[] }).team;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}

export interface AppConfig {
  store: 'memory' | 'graph' | 'sheets';
  slack: { botToken: string; appToken?: string; signingSecret?: string; port: number };
  notifyChannelId?: string;
  remindersEnabled: boolean;
  devAdminSlackId?: string;
  graph?: GraphConfig;
  google?: GoogleConfig;
}

export interface GraphConfig {
  tenantId: string;
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  siteId: string;
  driveId: string;
  itemId: string;
}

export function graphConfigFromEnv(): GraphConfig {
  return {
    tenantId: required('MS_TENANT_ID'),
    clientId: required('MS_CLIENT_ID'),
    clientSecret: process.env.MS_CLIENT_SECRET || undefined,
    refreshToken: process.env.MS_REFRESH_TOKEN || undefined,
    siteId: required('SP_SITE_ID'),
    driveId: required('SP_DRIVE_ID'),
    itemId: required('SP_ITEM_ID'),
  };
}

export function googleConfigFromEnv(): GoogleConfig {
  return {
    sheetId: parseSheetId(required('GOOGLE_SHEET_ID')),
    keyJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || undefined,
    keyFile: resolve(ROOT, process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || 'data/google-service-account.json'),
  };
}

export function loadConfig(): AppConfig {
  const store = (process.env.STORE ?? 'memory') as AppConfig['store'];
  if (!['memory', 'graph', 'sheets'].includes(store)) throw new Error('STORE must be "memory", "sheets" or "graph"');
  const appToken = process.env.SLACK_APP_TOKEN || undefined;
  const signingSecret = process.env.SLACK_SIGNING_SECRET || undefined;
  if (!appToken && !signingSecret) {
    throw new Error('Set SLACK_APP_TOKEN (Socket Mode) or SLACK_SIGNING_SECRET (HTTP mode)');
  }
  return {
    store,
    slack: { botToken: required('SLACK_BOT_TOKEN'), appToken, signingSecret, port: Number(process.env.PORT ?? 3000) },
    notifyChannelId: process.env.NOTIFY_CHANNEL_ID || undefined,
    remindersEnabled: (process.env.REMINDERS_ENABLED ?? 'false').toLowerCase() === 'true',
    devAdminSlackId: process.env.DEV_ADMIN_SLACK_ID || undefined,
    graph: store === 'graph' ? graphConfigFromEnv() : undefined,
    google: store === 'sheets' ? googleConfigFromEnv() : undefined,
  };
}
