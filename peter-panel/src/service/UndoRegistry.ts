import { randomUUID } from 'node:crypto';
import type { FieldKey, Panelist } from '../domain/types.js';

export const UNDO_WINDOW_MS = 10 * 60 * 1000;

export interface UndoRecord {
  id: string;
  actorId: string;
  topicId: string;
  kind: 'add' | 'update';
  before: Panelist | null;
  after: Panelist;
  fields: FieldKey[];
  diff: string;
  expiresAt: number;
}

/** Ten-minute, single-use undo tokens. Lives in memory: a restart drops pending undos. */
export class UndoRegistry {
  private records = new Map<string, UndoRecord>();

  constructor(private now: () => number = Date.now) {}

  register(rec: Omit<UndoRecord, 'id' | 'expiresAt'>): string {
    this.prune();
    const id = randomUUID();
    this.records.set(id, { ...rec, id, expiresAt: this.now() + UNDO_WINDOW_MS });
    return id;
  }

  /** Returns the record if still valid, without consuming it. */
  peek(id: string): UndoRecord | undefined {
    const rec = this.records.get(id);
    if (!rec || rec.expiresAt < this.now()) return undefined;
    return rec;
  }

  consume(id: string) {
    this.records.delete(id);
  }

  private prune() {
    const t = this.now();
    for (const [id, rec] of this.records) if (rec.expiresAt < t) this.records.delete(id);
  }
}
