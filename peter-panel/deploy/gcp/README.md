# Run Peter Panel on Google Cloud's free server

This puts Peter Panel on Google Cloud's always-free **e2-micro** server, so it runs 24/7 without your laptop. It takes about 20 minutes, mostly clicking through the Google Cloud console.

> **About cost.** Google Cloud's free tier includes one e2-micro server per billing account in `us-central1`, `us-east1` or `us-west1`, with a standard persistent disk. Google needs a card on file to turn on Compute Engine. Free-tier terms change, so step 2 sets a **$1 budget alert**: Google emails you if anything starts costing money, and you can stop the server right away (step 8).

## 1. Open your project

Go to <https://console.cloud.google.com> and pick the **Peter Panel** project at the top. It's the one that holds the `peter-panel@…iam.gserviceaccount.com` service account.

## 2. Billing and a $1 alert

1. Open ☰ → **Billing** and link a billing account (add a card) if the project doesn't have one.
2. Open **Billing → Budgets & alerts → Create budget**:
   - Name: `Peter Panel safety net`
   - Projects: Peter Panel
   - Amount: **$1**
   - Alerts at 50%, 90% and 100%, emailed to you
3. Click **Finish**.

## 3. Create the server

Open ☰ → **Compute Engine → VM instances**. Click **Enable** if asked, wait for it, then click **Create instance** and set:

| Setting | Value |
|---|---|
| Name | `peter-panel` |
| Region | **us-central1 (Iowa)**, or us-east1 / us-west1 |
| Machine | **E2** series → **e2-micro** |
| Boot disk → Change | **Debian GNU/Linux 12**, disk type **Standard persistent disk**, size **10 GB** |
| Firewall | leave HTTP / HTTPS **unticked**; Peter Panel needs no incoming traffic |

Check the monthly estimate on the right before you click **Create**.

## 4. Upload your two secret files

1. In the VM list, click **SSH** next to `peter-panel`. A terminal opens in a browser window.
2. In that window, click **⚙ (or ⋮) → Upload file** and upload these from your laptop:
   - `C:\Users\adity\Aditya-Mahendran\peter-panel\.env`
   - `C:\Users\adity\Aditya-Mahendran\peter-panel\data\google-service-account.json`

`.env` is a hidden file, so Windows' file picker may not list it. Paste the full path above into the **File name** box instead.

## 5. Install

In the same SSH window, paste this and press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/aditya-mahendran/Aditya-Mahendran/claude/peter-panel-slack-app-nnu1ko/peter-panel/deploy/gcp/install.sh | sudo bash
```

It installs Node.js, downloads and builds Peter Panel, moves your two files into place, and starts it as a service. It ends with `active (running)` and `Done.`

## 6. Stop the laptop copy

In PowerShell on your laptop, press **Ctrl+C**. Only one copy of Peter Panel should run at a time; with two, the Sunday check-in would post twice.

## 7. Check it works

In Slack, run `/panel help`, then `/panel checkin`.

To watch what it's doing, run this in the SSH window (Ctrl+C to stop watching):

```bash
sudo journalctl -u peter-panel -f
```

## Day to day

| To… | Run in the SSH window |
|---|---|
| Update to the latest code | the same `curl … \| sudo bash` command from step 5 |
| Change a setting in `.env` | `sudo nano /opt/peter-panel/peter-panel/.env`, save (Ctrl+O, Enter, Ctrl+X), then `sudo systemctl restart peter-panel` |
| Restart | `sudo systemctl restart peter-panel` |
| See whether it's running | `sudo systemctl status peter-panel` |

## 8. Stop it or remove it

In **Compute Engine → VM instances**, tick `peter-panel` and click:
- **Stop** to pause it. Peter Panel stops answering.
- **Delete** to remove it completely.

You can also delete the whole project under **IAM & Admin → Settings → Shut down**.
