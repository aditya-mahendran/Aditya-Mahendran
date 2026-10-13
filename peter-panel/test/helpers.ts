import { loadTopics } from '../src/config.js';
import type { TeamMember } from '../src/domain/types.js';
import { PanelService } from '../src/service/PanelService.js';
import { defaultLists } from '../src/store/defaults.js';
import { MemoryStore } from '../src/store/MemoryStore.js';

export const topics = loadTopics();
export const topic = (id: string) => topics.find((t) => t.id === id)!;

/** 10:00 CDT on Oct 13 2026. */
export const NOW = new Date('2026-10-13T15:00:00Z');

export const TEAM: TeamMember[] = [
  { slackId: 'UKEANAN', name: 'Keanan Crasto', role: 'owner', topic: '' },
  { slackId: 'UGIA', name: 'Gia Levatich', role: 'owner', topic: '' },
  { slackId: 'ULAUREN', name: 'Lauren Murphy', role: 'owner', topic: '' },
  { slackId: '', name: 'Alex Nobel', role: 'owner', topic: '' },
  { slackId: 'UADI', name: 'Adi Mahendran', role: 'admin', topic: '' },
];

export function setup(opts: { now?: () => Date } = {}) {
  const store = new MemoryStore({
    lists: defaultLists(topics),
    team: TEAM,
    reference: [
      {
        priority: '', lastUpdated: '', status: 'Declined', confirmed: '', name: 'Pat Lastyear', role: 'CEO', company: 'OldCo',
        alum: '', description: '', speakerType: '', panelA: 'Air Time', panelB: '', notes: 'Said maybe next year', location: '', connection: '',
      },
    ],
  });
  const notices: string[] = [];
  let clock = opts.now ?? (() => NOW);
  const service = new PanelService(store, topics, {
    now: () => clock(),
    notifier: { notify: async (t) => void notices.push(t) },
    mirrorRetryDelayMs: 0,
  });
  const as = async (slackId: string) => service.identify(slackId);
  return { store, service, notices, as, setClock: (fn: () => Date) => (clock = fn) };
}
