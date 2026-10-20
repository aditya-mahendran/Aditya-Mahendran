import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { ConfidentialClientApplication, PublicClientApplication, type ICachePlugin } from '@azure/msal-node';
import type { GraphConfig } from '../../config.js';
import { logger } from '../../logger.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const RETRY_STATUSES = new Set([429, 503, 504]);
const MAX_TRIES = 3;

export interface TokenProvider {
  getToken(): Promise<string>;
}

/** Option A: app-only (client credentials) with Sites.Selected granted to the one site. */
export function appOnlyTokenProvider(cfg: GraphConfig): TokenProvider {
  if (!cfg.clientSecret) throw new Error('MS_CLIENT_SECRET is required for app-only auth');
  const app = new ConfidentialClientApplication({
    auth: { clientId: cfg.clientId, clientSecret: cfg.clientSecret, authority: `https://login.microsoftonline.com/${cfg.tenantId}` },
  });
  return {
    async getToken() {
      const res = await app.acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] });
      if (!res?.accessToken) throw new Error('Could not get a Graph token (app-only)');
      return res.accessToken;
    },
  };
}

export const DELEGATED_SCOPES = ['Files.ReadWrite', 'Sites.ReadWrite.All', 'offline_access'];

/** Persists MSAL's token cache (holds the refresh token) to a local file. */
export function fileCachePlugin(path: string): ICachePlugin {
  return {
    async beforeCacheAccess(ctx) {
      if (existsSync(path)) ctx.tokenCache.deserialize(readFileSync(path, 'utf8'));
    },
    async afterCacheAccess(ctx) {
      if (ctx.cacheHasChanged) writeFileSync(path, ctx.tokenCache.serialize(), { mode: 0o600 });
    },
  };
}

/**
 * Option B: delegated. A club officer signs in once with `npm run device-login`, which
 * stores MSAL's cache at MS_TOKEN_CACHE_PATH. MS_REFRESH_TOKEN works as a bootstrap.
 */
export function delegatedTokenProvider(cfg: GraphConfig, cachePath = process.env.MS_TOKEN_CACHE_PATH ?? 'data/token-cache.json'): TokenProvider {
  const app = new PublicClientApplication({
    auth: { clientId: cfg.clientId, authority: `https://login.microsoftonline.com/${cfg.tenantId}` },
    cache: { cachePlugin: fileCachePlugin(cachePath) },
  });
  return {
    async getToken() {
      const [account] = await app.getTokenCache().getAllAccounts();
      if (account) {
        const res = await app.acquireTokenSilent({ account, scopes: DELEGATED_SCOPES });
        if (res?.accessToken) return res.accessToken;
      }
      if (cfg.refreshToken) {
        const res = await app.acquireTokenByRefreshToken({ refreshToken: cfg.refreshToken, scopes: DELEGATED_SCOPES });
        if (res?.accessToken) return res.accessToken;
      }
      throw new Error('No delegated Graph token. Run `npm run device-login` to sign in.');
    },
  };
}

export function tokenProviderFromConfig(cfg: GraphConfig): TokenProvider {
  return cfg.clientSecret ? appOnlyTokenProvider(cfg) : delegatedTokenProvider(cfg);
}

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

export interface GraphClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
  /** Prefix for error messages, e.g. "Microsoft Graph" or "Google Sheets". */
  label?: string;
}

/**
 * Thin Graph REST client: bearer auth, JSON, and retry on 429/503/504 that honours
 * Retry-After with exponential backoff, giving up after 3 tries.
 */
export class GraphClient {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly baseUrl: string;
  private readonly label: string;

  constructor(
    private readonly tokens: TokenProvider,
    opts: GraphClientOptions = {},
  ) {
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.baseUrl = opts.baseUrl ?? GRAPH;
    this.label = opts.label ?? 'Microsoft Graph';
  }

  async request<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await this.tokens.getToken()}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.ok) {
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_TRIES) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
        logger.warn('api.retry', { api: this.label, status: res.status, attempt, waitMs: wait });
        await this.sleep(wait);
        continue;
      }
      let code = 'unknown';
      let message = `${res.status} ${res.statusText}`;
      try {
        // Graph: { error: { code: "itemNotFound" } }; Google: { error: { code: 403, status: "PERMISSION_DENIED" } }
        const err = (await res.json()) as { error?: { code?: string | number; status?: string; message?: string } };
        code = String(err.error?.status ?? err.error?.code ?? code);
        message = err.error?.message ?? message;
      } catch {
        // non-JSON error body
      }
      throw new GraphError(res.status, code, `${this.label}: ${message}`);
    }
  }
}

/**
 * A persistent workbook session reused for a burst of calls and closed after it
 * goes idle. Calls without a live session fall back to sessionless requests.
 */
export class WorkbookSession {
  private id: string | null = null;
  private opening: Promise<string | null> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly graph: GraphClient,
    private readonly workbookPath: string,
    private readonly idleMs = 60_000,
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const id = await this.ensure();
    try {
      return await this.graph.request<T>(method, `${this.workbookPath}${path}`, body, id ? { 'workbook-session-id': id } : {});
    } catch (err) {
      if (err instanceof GraphError && /session/i.test(err.code)) {
        this.id = null; // expired; next call opens a new one
        return this.graph.request<T>(method, `${this.workbookPath}${path}`, body);
      }
      throw err;
    } finally {
      this.touch();
    }
  }

  private async ensure(): Promise<string | null> {
    if (this.id) return this.id;
    this.opening ??= this.graph
      .request<{ id: string }>('POST', `${this.workbookPath}/createSession`, { persistChanges: true })
      .then((s) => (this.id = s.id))
      .catch((err) => {
        logger.warn('graph.session_failed', { error: (err as Error).message });
        return null;
      })
      .finally(() => (this.opening = null));
    return this.opening;
  }

  private touch() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.close(), this.idleMs);
    this.idleTimer.unref?.();
  }

  async close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const id = this.id;
    this.id = null;
    if (!id) return;
    await this.graph
      .request('POST', `${this.workbookPath}/closeSession`, {}, { 'workbook-session-id': id })
      .catch(() => undefined);
  }
}
