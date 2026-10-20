import { existsSync, readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import type { TokenProvider } from '../graph/GraphClient.js';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface GoogleConfig {
  /** Spreadsheet ID (the long part of the sheet URL). */
  sheetId: string;
  /** Path to the service account's JSON key file. */
  keyFile?: string;
  /** The JSON key itself, for hosts where a file is awkward. */
  keyJson?: string;
}

/** Accepts a bare spreadsheet ID or a full https://docs.google.com/spreadsheets/d/<id>/... URL. */
export function parseSheetId(value: string): string {
  const m = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return (m ? m[1] : value).trim();
}

interface ServiceAccountKey {
  client_email?: string;
  private_key?: string;
}

function readKey(cfg: GoogleConfig): ServiceAccountKey {
  if (cfg.keyJson) return JSON.parse(cfg.keyJson) as ServiceAccountKey;
  if (cfg.keyFile && existsSync(cfg.keyFile)) return JSON.parse(readFileSync(cfg.keyFile, 'utf8')) as ServiceAccountKey;
  throw new Error(
    `No Google service account key. Put the downloaded JSON key at ${cfg.keyFile ?? 'data/google-service-account.json'} ` +
      'or set GOOGLE_SERVICE_ACCOUNT_JSON (see README → Google Sheets).',
  );
}

/** The service account's email: the address the sheet must be shared with. */
export function serviceAccountEmail(cfg: GoogleConfig): string {
  return readKey(cfg).client_email ?? '(unknown service account)';
}

export function googleTokenProvider(cfg: GoogleConfig): TokenProvider {
  const auth = new GoogleAuth({ credentials: readKey(cfg), scopes: [SHEETS_SCOPE] });
  return {
    async getToken() {
      const token = await auth.getAccessToken();
      if (!token) throw new Error('Could not get a Google access token for the service account');
      return token;
    },
  };
}
