# USPTO Patent File Wrapper Search

A web UI for the **USPTO Open Data Portal** Patent File Wrapper API
(`api.uspto.gov`), with:

- a serverless **proxy** that keeps your API key private and avoids browser CORS,
- a **scheduled cron job** (run via cron-job.org) that watches the patent
  applications you track and flags newly filed documents,
- a **reexamination determinations watcher** across all ex parte reexams,
- optional **email digests** of new filings and reexam determinations (via Resend),
- in-app **document access** (download the actual PDF/XML/DOCX of any filing).

```
uspto-search/
├── uspto-search.html           # search UI + "Tracked Proceedings" (served at /uspto-search)
├── privacy.html                # privacy policy (served at /privacy)
├── reexam.html                 # reexam determinations list (served at /reexam)
├── api/
│   ├── search.js               # POST  → /applications/search
│   ├── application.js          # GET   → /applications/{appNum}[/{section}]
│   ├── document.js             # GET   → streams a document PDF/XML/DOCX
│   ├── watchlist.js            # GET/POST/DELETE tracked proceedings + findings
│   ├── reexam.js               # GET   → recent reexam determinations
│   └── cron/
│       ├── check-filings.js    # tracked-application filings scan
│       └── reexam-scan.js      # reexam determinations scan
├── lib/
│   ├── uspto.js                # USPTO API helpers
│   ├── db.js                   # Postgres helpers + schema
│   └── email.js                # Resend digests (optional)
├── vercel.json                 # cleanUrls + root redirect
├── package.json
└── .env.example
```

> **Note:** `index.html` lives at the project **root** (not in a `public/`
> folder). For a no-framework Vercel project, static files are served from the
> root — putting the page in `public/` causes a `404: NOT_FOUND` at `/`.

## 1. Get a USPTO API key (required)

Request a free key at **https://data.uspto.gov/apis/getting-started** → "My API
Key". The proxy reads it from `USPTO_API_KEY`, so it never reaches the browser.

## 2. Add a Postgres database (required for tracking)

The watchlist and "new filings" detection need persistent storage.

1. In your Vercel project: **Storage → Create Database → Postgres** (Neon).
2. Connect it to the project. Vercel automatically injects the connection
   env vars (`POSTGRES_URL`, etc.) into all deployments.
3. No manual migration needed — the tables are created on first use
   (`CREATE TABLE IF NOT EXISTS`, see `lib/db.js`).

## 3. Set environment variables

In **Project → Settings → Environment Variables**:

| Variable | Required | Purpose |
|---|---|---|
| `USPTO_API_KEY` | ✅ | Your USPTO key, sent as `X-API-KEY` |
| `CRON_SECRET` | ✅ (prod) | Secures the cron route. Generate with `openssl rand -base64 32`. Your scheduler (cron-job.org) sends it as `Authorization: Bearer …`; the handler rejects anything that doesn't match. |
| `POSTGRES_URL` | ✅ | Auto-added by the Postgres integration above |
| `ADMIN_PASSWORD` | optional | Protects **Edit emails** and **Remove** in Tracked Proceedings. If set, those actions require it (sent as the `X-Admin-Password` header); if unset, they're open. |
| `RESEND_API_KEY` | optional | Enables email digests (see below) |
| `DIGEST_FROM` | optional | Verified sender, e.g. `USPTO Watch <alerts@yourdomain.com>` |
| `DIGEST_TO` | optional | Recipient for the **"Send test email"** button |
| `REEXAM_DIGEST_TO` | optional | Recipient(s) for the daily reexam-determinations digest (falls back to `DIGEST_TO`) |
| `APP_BASE_URL` | optional | Overrides the auto-detected site URL in email links |

> After adding/changing env vars, **redeploy** so the functions pick them up.

## 4. Deploy

Push this folder to a GitHub repo and **Import** it at https://vercel.com
(or run `vercel` from the folder with the CLI). On deploy, Vercel:

- serves the root static files (`uspto-search.html` at `/uspto-search`, `privacy.html` at `/privacy`),
- turns each file in `api/` into a serverless function.

Your site is live at `https://<project>.vercel.app`.

## How the cron works

The check job is the HTTP endpoint **`/api/cron/check-filings`**. Each run:

- For each tracked application it pulls the current document list, inserts any
  `documentIdentifier` it hasn't seen before, and flags it `is_new = true`.
- When you **start tracking** an application, its *existing* documents are
  recorded as a baseline (`is_new = false`) so only **future** filings show up
  as new.
- New filings appear in the **"New Filings"** panel on the page (click **Mark all
  as seen** to clear them) and trigger email alerts to each application's
  recipients. **No email is sent when there are nothing new.**

The endpoint requires `Authorization: Bearer <CRON_SECRET>`.

### Scheduling with cron-job.org (free, hourly)

Vercel's Hobby plan limits *Vercel's own* cron scheduler to once per day, but the
endpoint is a normal URL that any scheduler can call as often as you like. To run
it hourly for free, use [cron-job.org](https://cron-job.org):

1. Create a free account → **Create cronjob**.
2. **Title:** USPTO check filings
3. **URL:** `https://andy-ong.com/api/cron/check-filings`
4. **Schedule:** Every hour (e.g. "Every 1 hour", or pattern: minute `0`, every hour).
5. **Request method:** GET
6. Authenticate one of two ways (the secret must equal the `CRON_SECRET` env var):
   - **Header (preferred):** under **Advanced → Headers**, add `Authorization` = `Bearer <CRON_SECRET>` (the value may also be just `<CRON_SECRET>`), **or**
   - **URL key (simplest):** append `?key=<CRON_SECRET>` to the URL, e.g. `https://andy-ong.com/api/cron/check-filings?key=<CRON_SECRET>` — no header needed.
7. Save. (Optional: enable failure notifications so you're told if a run errors.)

> A **401 Unauthorized** means the secret didn't match. Check for typos/trailing
> spaces in either place, or just use the `?key=` URL form to rule out header issues.

> There is **no** `crons` entry in `vercel.json` — scheduling is handled entirely
> by cron-job.org.

**Test it manually** with the same request:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://andy-ong.com/api/cron/check-filings
```

A successful run returns JSON like `{ "ok": true, "checked": N, "totalNew": M, "emails": [...] }`.

> **Function duration note:** on Vercel Hobby, functions have a short max
> duration. Each run checks every tracked application sequentially, so a very
> large tracked list could approach the limit — fine for a normal number of
> applications.

## Email digests (optional)

When a cron run finds new documents, it can email you a digest. It's **off by
default** and turns on automatically once these env vars are set:

1. Create a free account at https://resend.com and add an **API key**.
2. **Verify a sending domain** (or use Resend's `onboarding@resend.dev` sender
   for testing).
3. Set the env vars and redeploy:
   - `RESEND_API_KEY` — your Resend key
   - `DIGEST_FROM` — e.g. `USPTO Watch <alerts@yourdomain.com>` (must match a
     verified domain) — the global sender
   - `DIGEST_TO` — recipient for the **"Send test email"** button only
   - `APP_BASE_URL` *(optional)* — only if the auto-detected URL for the download
     links in the email is wrong

**Per-application recipients.** New-filing alerts are addressed **per application**:
when you track an application you set its **Notify (emails)** list (comma-separated,
editable later via the ✎ button on each tracked item). Each run:

- **New filings** → grouped by recipient set, so each recipient set gets **one
  email** covering all of their applications, with one-click download links
  (pointing back at your `/api/document` proxy).
- **An application with no recipients listed sends nothing.**
- **No email is sent when there are no new filings** (so frequent runs don't
  flood your inbox).

If the email vars are unset, the cron simply skips sending and you still get the
in-app "New Filings" panel. The cron's JSON response includes an `emails` array
(the per-recipient-set sends) so you can confirm it from the manual `curl` test
above.

## Reexamination determinations watcher (all ex parte reexams)

A separate subsystem watches **all** ex parte reexaminations (90/ series) for new
**determinations** — orders granting (`RXREXO`) or denying (`RXREXD`) reexam —
without you naming specific proceedings. Endpoint: **`/api/cron/reexam-scan`**.

Each run:
1. **Once/day:** enumerates ex parte reexams filed in the last 6 months into a
   watch table (and prunes ones older than ~9 months — past the determination window).
2. **Every run:** scans the next chunk (~25, least-recently-scanned first) of
   not-yet-determined reexams for `RXREXO`/`RXREXD` documents; records new ones.
   A reexam drops out of the scan once its determination is found.
3. **Once/day:** emails a digest of newly found determinations to
   `REEXAM_DIGEST_TO` (or `DIGEST_TO`). No email on days with none.

Results are also listed at **`/reexam`** (linked in the footer).

**Schedule it** with a second cron-job.org job (same as the filings one, different URL):
- **URL:** `https://andy-ong.com/api/cron/reexam-scan` (or `…/reexam-scan?key=<CRON_SECRET>`)
- **Schedule:** every hour · **Method:** GET
- **Auth:** header `Authorization: Bearer <CRON_SECRET>` **or** the `?key=` URL form above

The work is chunked across the hourly runs (rolling cursor) so each invocation
stays within Vercel Hobby limits. Test manually:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://andy-ong.com/api/cron/reexam-scan
```

> Reexams aren't tagged by a "type" field in ODP — they're identified by
> control-number prefix (`applicationNumberText:90*`). Coverage and the exact
> determination codes (`RXREXO`/`RXREXD`) were confirmed against live data.

## How document access works

Two steps, both proxied through your key:

1. **List:** *Application Lookup → Documents* calls
   `GET /applications/{appNum}/documents`, which returns each document's code,
   date, and available formats.
2. **Download:** each format links to `/api/document?appNum=…&documentId=…&format=PDF`,
   which streams `https://api.uspto.gov/api/v1/download/applications/{appNum}/{documentId}.pdf`
   back to the browser with the key injected. (The upstream host is hard-coded in
   `document.js` — no open-proxy risk.)

The same download links appear next to each item in the **New Filings** panel.

## Local development

Local use requires Node 18+ and the env vars, via `vercel dev`:

```bash
npm i -g vercel
vercel link
vercel env pull .env.local   # pulls USPTO_API_KEY, CRON_SECRET, POSTGRES_URL
vercel dev
```

Opening `index.html` directly (file://) loads the UI but the `/api/*`
routes won't run — they need the Vercel runtime.

## Notes & verification

- Searchable fields live under `applicationMetaData.*` (e.g. `inventionTitle`,
  `filingDate`, `patentNumber`, `applicationStatusDescriptionText`,
  `firstInventorName`, `firstApplicantName`).
- The exact field names, document response shape, and query grammar are defined
  by USPTO and may evolve. Use the **Advanced (Raw JSON)** tab and the **Raw JSON**
  results toggle to confirm shapes against the official docs:
  - https://data.uspto.gov/apis/patent-file-wrapper/search
  - https://data.uspto.gov/apis/patent-file-wrapper/documents
  - https://data.uspto.gov/documents/documents/ODP-API-Query-Spec.pdf
- See **"Email digests"** below for enabling email alerts.
