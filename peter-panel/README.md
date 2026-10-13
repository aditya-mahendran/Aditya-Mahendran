# Peter Panel 🎤

*The KCC panel planning app.* A Slack app that lets each Kellogg Climate Conference 2026 programming team member log panelist outreach from Slack. Every update goes into their panel's own green tab in the shared SharePoint tracker (`KCC 2026 Panel Tracker.xlsx`) and is mirrored to **Panel Tracker** and the **Update Log**.

```
Topic owner ──/panel──▶ Slack app (Bolt, Socket Mode) ──Graph Excel API──▶ SharePoint workbook
                         check role (Team tab)                             green topic tabs
                         modal + validation                                Panel Tracker (mirror)
                         PanelService ─▶ TrackerStore (queue + 60 s cache) Update Log · Team
#kcc-programming ◀── Confirmed / Declined / picks
```

## Commands

| Command | Who | What it does |
|---|---|---|
| `/panel pick` | owner | Claim one of the unclaimed panels; creates its green tab |
| `/panel add` | owner, lead | Add Panelist modal (leads also choose the panel) |
| `/panel update [name]` | owner, lead | Update modal. Searchable name picker, or prefilled when a name is given |
| `/panel list` | owner, lead | Your panel's panelists grouped by status, each with an Update button (leads: `/panel list <panel>`) |
| `/panel find <name>` | everyone on Team | Search every topic tab and last year's reference |
| `/panel status` | lead | Panels × Confirmed / Interested / In outreach / Not started / Closed, plus who hasn't picked |
| `/panel assign @user <panel>` | lead | Set or change someone's panel (by number 1–15, alias or name) |
| `/panel resync` | lead | Rebuild Panel Tracker from the topic tabs |
| `/panel reload` | lead | Re-read Team, topic config and dropdown lists |
| `/panel help` | everyone | Usage |

Every write sets **B** (Last Updated) to today in Chicago time. Moving to **Confirmed** sets **D** to `YES 🥳` and moving off it clears D. Notes are appended as `MM/DD (Name): text`. Each write adds one Update Log row with a one-line diff. The confirmation message has an **Undo** button that works for 10 minutes.

## Quick start (local, no SharePoint)

The in-memory store lets you try every Slack flow before SharePoint access is sorted.

1. **Create the Slack app.** Go to <https://api.slack.com/apps>, then **Create New App → From an app manifest**, and paste [`manifest.yml`](manifest.yml). Install it to the workspace.
2. Under **Basic Information → App-Level Tokens**, create a token with the `connections:write` scope (`xapp-…`).
3. Set up the env file:
   ```bash
   cd peter-panel
   cp .env.example .env   # fill SLACK_BOT_TOKEN, SLACK_APP_TOKEN, NOTIFY_CHANNEL_ID
   # Optional: DEV_ADMIN_SLACK_ID=<your Slack member ID> to try the lead commands
   npm install
   npm run dev
   ```
4. In Slack, run `/panel pick`. Owners are matched to the Team list by their Slack real name the first time they use the app.

The memory store loads last year's reference from `data/reference-2025.json` if it exists (gitignored, because panelist data stays out of the repo). Otherwise it uses a small fictional sample.

## Connecting the real workbook

1. **Choose auth** (open question 1):
   - **Option A, app-only (preferred):** an Azure AD app registration with `Sites.Selected`, granted to the KSM-KelloggEnergyandSustainability site by a Northwestern tenant admin. Set `MS_TENANT_ID`, `MS_CLIENT_ID` and `MS_CLIENT_SECRET`.
   - **Option B, delegated:** leave `MS_CLIENT_SECRET` empty and run `npm run device-login` once as a club officer. MSAL's token cache, which holds the refresh token, is saved to `MS_TOKEN_CACHE_PATH`. This breaks if that person leaves or resets their password.
2. **Find the IDs:** run `npm run resolve-sharepoint` and paste the `SP_SITE_ID` / `SP_DRIVE_ID` / `SP_ITEM_ID` lines into `.env`.
3. **Prepare the workbook** with `npm run setup-workbook -- --dry-run` first, then run it for real. The script is idempotent and does three things:
   - Creates the hidden `Lists` tab with the 15 panel names and points Panel Tracker's K/L dropdowns at it. The names are over Excel's 255-character limit for an inline list.
   - Converts Panel Tracker to the table `tbl_PanelTracker`.
   - Creates the `Team` tab with the ten names. With `SLACK_BOT_TOKEN` set, it fills in Slack IDs via `users.list`.

   Before launch, also run it with `--clear-update-log` to remove the 10/12 test row. Use `--fix-reference-swap` to move the 76 cities from Connection to Location in the 2025 tab. Review that one with `--dry-run` first, because it is a heuristic.
4. Set `STORE=graph` and restart.

> **Test against a copy first.** Point `SP_ITEM_ID` at a copy of the workbook in a test folder for the first run, never the live file (build-plan step 4).

## Deploying

The app needs one always-on instance. Socket Mode means no public URL. `Dockerfile` works on Railway, Render or Fly.io, or use `npm run build && npm start`. Set the same env vars as `.env`. Don't run two instances, because writes are serialized by one in-process queue.

Scheduled jobs (Chicago time):
- **02:00 daily:** resync Panel Tracker from the topic tabs, which picks up direct Excel edits.
- **Mondays 09:00:** each owner gets a DM with counts and anyone stuck in Outreach 1/2 Sent for 7+ days, and the status digest goes to the channel. Turned on with `REMINDERS_ENABLED=true`.

## Code map

| Path | What |
|---|---|
| `config/topics.json` | The 15 panels: column-K name, tab name (≤31 chars, no `?`), table name, Slack alias |
| `config/team.json` | Seed names/roles for the Team tab (and the memory store) |
| `src/domain/` | Column map A–O, name normalization, FR-4 auto fields, notes, diffs, validation, Chicago time |
| `src/service/PanelService.ts` | All business rules: permissions, pick/assign, add/update, duplicate check, mirror + retry, undo, resync, status, reminders |
| `src/store/TrackerStore.ts` | The one storage interface. Slack code never calls Graph |
| `src/store/MemoryStore.ts` | In-memory implementation for tests and local dev |
| `src/store/graph/` | Graph implementation: auth (Option A/B), retry on 429/503/504 honouring `Retry-After`, workbook sessions, 60 s cache |
| `src/slack/` | Bolt handlers, Block Kit modals, message formatting |
| `src/jobs/scheduler.ts` | Nightly resync and weekly reminders (`node-cron`) |
| `scripts/` | `setup-workbook`, `resolve-sharepoint`, `device-login` |

```bash
npm test          # 86 tests: rules, permissions, service, mirror, undo, Graph client/store, Slack handlers
npm run typecheck
```

## Decisions and notes

- **Option B panels** (open question 2): only stored in column L, not copied to the other panel's tab. This is easy to change in `PanelService.addPanelist`.
- **Leads** (open question 5) are anyone with `admin` in the Team tab's Role column. No redeploy is needed to add one; run `/panel reload`.
- **Duplicates:** a match on another topic tab shows "Already on …" with **Add anyway / Cancel**. A match only in last year's reference doesn't block the add. Its 2025 status and notes appear in the confirmation instead.
- **Concurrency:** writes go through one queue. The Update modal remembers a hash of the row, and if the row changed in the meantime the user sees "This row changed — here's the latest" with fresh values.
- **Direct Excel edits are safe:** only changed cells are written, so edits to other cells survive.
- **New topic tabs** get 100 rows with dropdowns, converted to a table. The bot fills the first blank row before appending, and Undo of an add blanks the row rather than deleting it, so row positions never shift.
- **Formula safety:** text beginning with `=`, `+`, `-` or `@` is written as literal text.
- **Graph client:** a thin `fetch` wrapper with `@azure/msal-node` instead of `@microsoft/microsoft-graph-client`. This keeps the retry and `Retry-After` behaviour explicit and testable.
- **Undo tokens** and "Add anyway" drafts live in memory, so a restart drops any that are pending.
- **Not built yet:** FR-9 free-text DMs via the Claude API (v2). `im:history` is already in the manifest for when it lands.
