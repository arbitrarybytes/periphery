# Getting Started: Wiring Outlook.com and a GitHub Repo

A practical, copy-paste setup guide for the two connectors most people want
first. Both are configured entirely in **Settings** (tray icon → Settings) and
both store their credentials encrypted through your OS credential store —
nothing is written to disk in the clear, and nothing is sent anywhere except
directly from your machine to Microsoft or GitHub.

**Before you start:** Periphery must be running (`npm start`, or the installed
build). Confirm the local receiver is alive:

```powershell
Invoke-RestMethod http://127.0.0.1:49123/health
```

---

## Part 1 — Outlook.com (personal Microsoft account)

Periphery's Outlook connector polls **Microsoft Graph** directly from your
machine. It fires:

| Event | Cue | Why |
| ----- | --- | --- |
| Unread mail where you are in **To** | Comet (Tier 1) | Addressed to you personally |
| Unread mail where you are only in **CC** | Slow bottom glow (Tier 3) | Ambient; you are informed, not asked |
| A calendar event starting within 5 minutes | Orange pulse, `urgent` | Time-critical — pierces focus mode |

### Step 1: Get a Graph access token

The PoC takes a bearer token directly (OAuth device-code flow is on the
roadmap — see [vnext.md](vnext.md)). The fastest way to get one for a personal
`outlook.com` account is [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer),
which accepts personal Microsoft accounts as well as work accounts:

1. Open **Graph Explorer** and **sign in** with the same `outlook.com` account
   you have open in your browser.
2. Open the **Modify permissions** tab and consent to:
   *   `Mail.Read` — to see unread mail
   *   `Calendars.Read` — for meeting reminders
   You will be prompted to accept each one.
3. Run `GET https://graph.microsoft.com/v1.0/me` and confirm it returns your
   profile. Note the address in `userPrincipalName` (personal accounts often
   leave `mail` null) — **that exact address is what you enter in Step 2**.
4. Sanity-check the two endpoints Periphery actually calls:
   ```
   GET https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages?$filter=isRead eq false&$top=5
   GET https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=2026-07-26T00:00:00Z&endDateTime=2026-07-27T00:00:00Z
   ```
5. Open the **Access token** tab and copy the token.

### Step 2: Enter it in Periphery

Tray icon → **Settings** → **Outlook Integration**:

| Field | Value |
| ----- | ----- |
| Enable Outlook | on |
| User Email Address | the address from `userPrincipalName`, e.g. `you@outlook.com` |
| Microsoft Graph Token | paste the token |

Click **Save Settings**. The status line under the token box should change to
"A token is stored." Periphery runs a silent **baseline fetch** on start, so
your existing unread mail does *not* all fire at once — only mail that arrives
afterwards produces a cue.

### Step 3: Verify

Send yourself an email from another account (put your address in **To**). Within
60 seconds a comet should cross the screen. If you send one where you are only
CC'd, you get the slow bottom glow instead.

### Known limits (read this — it will save you confusion)

*   **The Graph Explorer token expires in about an hour.** When it does, the
    connector stops, the tray icon gets an **amber dot** whose tooltip reads
    *"Outlook: sign-in expired, re-enter your token"*, and the Settings banner
    says the same. That is the connector-health feature doing its job — paste a
    fresh token and save to resume. For a setup that survives longer, register
    your own Entra app and use a refresh-token flow; that is exactly the
    friction the planned OAuth device-code flow removes.
*   **"Hold cues while busy in Teams" will not work on a personal account.**
    The Graph **Presence API is delegated-work-account only** — personal
    Microsoft accounts are not supported. Leave that toggle off unless you are
    signing in with a work/school account. If you do turn it on with a personal
    token, Periphery fails *open*: it reports the auth failure once, releases
    the hold, and never silently mutes your cues.
*   **Poll rate:** every 60 seconds (mail + calendar), so a cue can lag an email
    by up to a minute. Meeting reminders look 6 minutes ahead and fire at the
    5-minute mark, so the poll interval cannot cause a missed reminder.

---

## Part 2 — A GitHub repository

The GitHub connector watches one repository's **Actions workflow runs** plus
**your notifications** feed:

| Event | Cue |
| ----- | --- |
| Workflow run concluded `success` | Green pulse |
| Workflow run concluded `failure` | Red bottom glow |
| Review requested / assigned / mentioned | Comet |
| Activity on something you authored | Pulse |

Other conclusions (`cancelled`, `skipped`, `action_required`) are recorded
silently — a cancelled build is not news.

### Step 1: Create a token

> **Use a classic PAT.** Fine-grained tokens still **cannot access the
> notifications API**, so a fine-grained token gives you workflow runs but no
> review requests or mentions.

Go to **GitHub → Settings → Developer settings → Personal access tokens →
Tokens (classic) → Generate new token (classic)** and select:

*   **`repo`** — workflow runs on private repos (use `public_repo` if the
    repository is public and you want the narrowest possible token)
*   **`notifications`** — review requests, mentions, assignments

Set an expiry you are comfortable with and copy the `ghp_…` value.

<details>
<summary>Fine-grained token alternative (Actions only, no notifications)</summary>

Repository access → the one repo, then **Repository permissions**:
*   *Actions*: **Read-only**
*   *Metadata*: **Read-only** (auto-selected)

The connector will report workflow runs normally; the notifications poll will
return 403 and that endpoint stays quiet.
</details>

### Step 2: Enter it in Periphery

Tray icon → **Settings** → **GitHub Integration**:

| Field | Value |
| ----- | ----- |
| Enable GitHub | on |
| Repository (owner/name) | e.g. `arbitrarybytes/notification-system` |
| Personal Access Token | paste the `ghp_…` token |

**Save Settings**. The repository must be exactly `owner/name` — no URL, no
trailing `.git`. Periphery validates the format and refuses to start the poller
otherwise (check the console if nothing happens).

### Step 3: Verify

Push a commit that triggers a workflow, or re-run one from the Actions tab.
Within ~45 seconds of it finishing you get a green pulse or a red bottom glow
naming the workflow.

### Known limits

*   **Poll rate:** every 45 seconds, 2 requests per poll ≈ **160 requests/hour**
    against a 5,000/hour authenticated limit — comfortable even with other tools
    sharing the token.
*   **Rate limits are handled as transient.** GitHub signals them as `403` with
    a drained `x-ratelimit-remaining` header; Periphery distinguishes that from
    a revoked token, keeps polling, shows an amber tray dot, and clears it
    automatically on the next good response.
*   **One repository per connector instance.** Watching several repos is a
    vNext item; today the notifications feed is account-wide, so mentions and
    review requests across all your repos already come through.

---

## Part 3 — Prove the whole loop in 60 seconds

Independent of any cloud service, wire your local tools with the built-in
wizard: tray icon → **Setup wizard** → *Choose folder…*. It detects a git
repository, `package.json`, and Docker in that folder and writes the recipes
for you (never overwriting anything you wrote). Or do it by hand:

```bash
# Any long command, ambient completion:
npm test && npx periphery done "Tests green" || npx periphery done --fail "Tests failed"
```

And for coding agents (Claude Code, Devin, Copilot), point them at the local
MCP server so they light the persistent beacon when work finishes — setup for
each client is in [agents.md](agents.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
| ------- | ----- | --- |
| Amber dot on the tray icon | A connector needs attention | Hover for the reason; Settings shows the same in a banner |
| "sign-in expired" for Outlook | Graph Explorer token aged out (~1h) | Paste a fresh token and Save |
| No cues at all, from anything | Focus mode is holding them | Check the tray menu's **Focus mode** checkbox and Windows Focus Assist; held cues appear as constellation stars |
| Cues arrive late, in a batch | Slack Tide is waiting for a typing pause | Working as designed (max 90s); toggle off in Settings |
| Nothing on `Invoke-RestMethod .../health` | App not running, or port 49123 taken | Start Periphery; check the console for `EADDRINUSE` |
| GitHub connector silent | Repo not `owner/name`, or missing scopes | Re-check both; classic PAT needed for notifications |

---

## Sources

*   [Graph Explorer](https://developer.microsoft.com/graph/graph-explorer) · [Microsoft Graph auth basics](https://learn.microsoft.com/en-us/graph/auth/auth-concepts) · [Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
*   [Manage presence state (work-account limitation)](https://learn.microsoft.com/en-us/graph/cloud-communications-manage-presence-state)
*   [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) · [Permissions required for fine-grained PATs](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens)
