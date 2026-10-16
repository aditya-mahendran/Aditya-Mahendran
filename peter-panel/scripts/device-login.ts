/**
 * Auth Option B (delegated): a club officer signs in once with a device code. The
 * MSAL token cache (which holds the refresh token) is saved to MS_TOKEN_CACHE_PATH,
 * default data/token-cache.json. Keep that file secret; it is gitignored.
 *
 *   npm run device-login
 */
import 'dotenv/config';
import { PublicClientApplication } from '@azure/msal-node';
import { DELEGATED_SCOPES, fileCachePlugin } from '../src/store/graph/GraphClient.js';

async function main() {
  const missing = ['MS_TENANT_ID', 'MS_CLIENT_ID'].filter((k) => !process.env[k]?.trim());
  if (missing.length) {
    throw new Error(
      `Set ${missing.join(' and ')} in .env first. They come from an Azure app registration ` +
        '(Azure portal → App registrations) with "Allow public client flows" turned on. See README → Connecting the real workbook.',
    );
  }
  const cachePath = process.env.MS_TOKEN_CACHE_PATH ?? 'data/token-cache.json';
  const app = new PublicClientApplication({
    auth: { clientId: process.env.MS_CLIENT_ID!, authority: `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}` },
    cache: { cachePlugin: fileCachePlugin(cachePath) },
  });
  const res = await app.acquireTokenByDeviceCode({
    scopes: DELEGATED_SCOPES,
    deviceCodeCallback: (r) => console.log(r.message),
  });
  console.log(`Signed in as ${res?.account?.username}. Token cache saved to ${cachePath}.`);
}

main().catch((err) => {
  console.error(err.errorMessage || err.message);
  process.exit(1);
});
