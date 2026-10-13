import type { ValidationErrors } from '../domain/rules.js';
import type { PanelistRow, Topic } from '../domain/types.js';

export type PanelErrorCode =
  | 'NOT_ON_TEAM'
  | 'NO_TOPIC'
  | 'FORBIDDEN'
  | 'ADMIN_ONLY'
  | 'UNKNOWN_TOPIC'
  | 'ALREADY_PICKED'
  | 'TAKEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'DUPLICATE'
  | 'CONFLICT'
  | 'NO_CHANGES'
  | 'UNDO_UNAVAILABLE';

export const MESSAGES: Record<PanelErrorCode, string> = {
  NOT_ON_TEAM: "You're not on the programming team list — ask a programming lead.",
  NO_TOPIC: 'Pick your topic first.',
  FORBIDDEN: 'You can only work on your own panel.',
  ADMIN_ONLY: 'Only programming leads can do that.',
  UNKNOWN_TOPIC: "I don't recognise that panel.",
  ALREADY_PICKED: 'You already have a panel. Ask a programming lead to change it (/panel assign).',
  TAKEN: 'Just taken — pick another.',
  NOT_FOUND: "I couldn't find that panelist on this panel's tab.",
  VALIDATION: 'Some fields need fixing.',
  DUPLICATE: 'This person is already on the tracker.',
  CONFLICT: 'This row changed — here’s the latest.',
  NO_CHANGES: 'Nothing changed, so nothing was written.',
  UNDO_UNAVAILABLE: 'That undo has expired or the row has changed since.',
};

export interface DuplicateMatch {
  topic: Topic;
  owner: string;
  status: string;
}

export interface ReferenceMatch {
  name: string;
  company: string;
  status: string;
  notes: string;
  panel: string;
}

export interface Duplicates {
  topicMatches: DuplicateMatch[];
  reference: ReferenceMatch[];
}

export type PanelErrorData =
  | { kind: 'validation'; errors: ValidationErrors }
  | { kind: 'duplicate'; duplicates: Duplicates }
  | { kind: 'conflict'; latest: PanelistRow; version: string };

export class PanelError extends Error {
  constructor(
    readonly code: PanelErrorCode,
    message: string = MESSAGES[code],
    readonly data?: PanelErrorData,
  ) {
    super(message);
    this.name = 'PanelError';
  }
}

export function isPanelError(err: unknown, code?: PanelErrorCode): err is PanelError {
  return err instanceof PanelError && (code === undefined || err.code === code);
}
