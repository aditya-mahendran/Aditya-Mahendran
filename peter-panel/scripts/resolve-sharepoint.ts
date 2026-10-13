/**
 * Finds the SharePoint site, drive and item IDs for the tracker and prints them as
 * env lines. Needs MS_TENANT_ID, MS_CLIENT_ID and MS_CLIENT_SECRET (or a delegated sign-in).
 *
 *   npm run resolve-sharepoint
 */
import 'dotenv/config';
import { GraphClient, tokenProviderFromConfig } from '../src/store/graph/GraphClient.js';

const HOST = process.env.SP_HOST ?? 'nuwildcat.sharepoint.com';
const SITE_PATH = process.env.SP_SITE_PATH ?? '/sites/KSM-KelloggEnergyandSustainability';
const FILE = process.env.SP_FILE_NAME ?? 'KCC 2026 Panel Tracker.xlsx';

async function main() {
  const graph = new GraphClient(
    tokenProviderFromConfig({
      tenantId: process.env.MS_TENANT_ID!,
      clientId: process.env.MS_CLIENT_ID!,
      clientSecret: process.env.MS_CLIENT_SECRET,
      refreshToken: process.env.MS_REFRESH_TOKEN,
      siteId: '',
      driveId: '',
      itemId: '',
    }),
  );
  const site = await graph.request<{ id: string; displayName: string }>('GET', `/sites/${HOST}:${SITE_PATH}`);
  console.log(`# Site: ${site.displayName}`);
  const drives = await graph.request<{ value: { id: string; name: string }[] }>('GET', `/sites/${site.id}/drives`);
  for (const drive of drives.value) {
    const hits = await graph.request<{ value: { id: string; name: string; webUrl: string }[] }>(
      'GET',
      `/sites/${site.id}/drives/${drive.id}/root/search(q='${encodeURIComponent(FILE.replace(/\.xlsx$/, '').replace(/'/g, "''"))}')`,
    );
    const file = hits.value.find((f) => f.name.toLowerCase().replace(/[_ ]/g, '') === FILE.toLowerCase().replace(/[_ ]/g, ''));
    if (file) {
      console.log(`# File: ${file.webUrl}`);
      console.log(`SP_SITE_ID=${site.id}`);
      console.log(`SP_DRIVE_ID=${drive.id}`);
      console.log(`SP_ITEM_ID=${file.id}`);
      return;
    }
  }
  throw new Error(`Couldn't find "${FILE}" in any document library on ${SITE_PATH}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
