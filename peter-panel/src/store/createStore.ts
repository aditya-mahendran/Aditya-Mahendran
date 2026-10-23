import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, loadTeamSeed, type AppConfig } from '../config.js';
import { emptyPanelist, type Panelist, type Topic } from '../domain/types.js';
import { logger } from '../logger.js';
import { defaultLists } from './defaults.js';
import { GraphClient, tokenProviderFromConfig } from './graph/GraphClient.js';
import { GraphStore } from './graph/GraphStore.js';
import { MemoryStore } from './MemoryStore.js';
import { googleTokenProvider, serviceAccountEmail } from './sheets/googleAuth.js';
import { SheetsStore } from './sheets/SheetsStore.js';
import type { TrackerStore } from './TrackerStore.js';

/**
 * Last year's panelists for the memory store. Real data goes in data/reference-2025.json
 * (gitignored); otherwise a small fictional sample is used.
 */
export function loadReference(): Panelist[] {
  const real = resolve(ROOT, 'data/reference-2025.json');
  const sample = resolve(ROOT, 'data/reference-sample.json');
  const path = existsSync(real) ? real : sample;
  if (!existsSync(path)) return [];
  const rows = JSON.parse(readFileSync(path, 'utf8')) as Partial<Panelist>[];
  return rows.map((r) => ({ ...emptyPanelist(), ...r }));
}

export function createMemoryStore(topics: Topic[], devAdminSlackId?: string): MemoryStore {
  const team = loadTeamSeed().map((m) => ({
    slackId: m.role === 'admin' && devAdminSlackId ? devAdminSlackId : '',
    name: m.name,
    role: m.role,
    topic: '',
  }));
  return new MemoryStore({ lists: defaultLists(topics), team, reference: loadReference() });
}

export type AppStore = TrackerStore & { close?: () => Promise<void>; check?: () => Promise<void> };

export function createStore(cfg: AppConfig, topics: Topic[]): AppStore {
  if (cfg.store === 'sheets') {
    const g = cfg.google!;
    const store = new SheetsStore(SheetsStore.client(googleTokenProvider(g)), g.sheetId, topics);
    const email = serviceAccountEmail(g);
    logger.info('store.sheets', { serviceAccount: email });
    return Object.assign(store, { check: () => store.verifyAccess(email) });
  }
  if (cfg.store === 'graph') {
    const g = cfg.graph!;
    const graph = new GraphClient(tokenProviderFromConfig(g));
    logger.info('store.graph', { auth: g.clientSecret ? 'app-only' : 'delegated' });
    return new GraphStore(graph, GraphStore.workbookPath(g.siteId, g.driveId, g.itemId), topics);
  }
  logger.warn('store.memory', { note: 'In-memory store: nothing is written to SharePoint and data is lost on restart.' });
  return createMemoryStore(topics, cfg.devAdminSlackId);
}
