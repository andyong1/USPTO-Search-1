# USPTO Patent File Wrapper Search

A web UI for the **USPTO Open Data Portal** Patent File Wrapper API
(`api.uspto.gov`), with:

- a serverless **proxy** that keeps your API key private and avoids browser CORS,
- a **daily cron job** that watches the patent applications you track and flags
  newly filed documents,
- optional **email digests** of new filings (via Resend),
- in-app **document access** (download the actual PDF/XML/DOCX of any filing).

```
uspto-search/
├── index.html                  # search UI + "Tracked Proceedings" panel (served at /)
├── api/
│   ├── search.js               # POST  → /applications/search
│   ├── application.js          # GET   → /applications/{appNum}[/{section}]
│   ├── document.js             # GET   → streams a document PDF/XML/DOCX
│   ├── watchlist.js            # GET/POST/DELETE tracked proceedings + findings
│   ├── test-email.js           # POST  → send a test digest email
│   └── cron/
│       └── check-filings.js    # daily diff job (secured by CRON_SECRET)
├── lib/
│   ├── uspto.js                # USPTO API helper
│   ├── db.js                   # Postgres helpers + schema
│   └── email.js                # Resend digest (optional)
├── vercel.json                 # cleanUrls + crons entry
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
| `CRON_SECRET` | ✅ (prod) | Secures the cron route. Generate with `openssl rand -base64 32`. Vercel sends it as `Authorization: Bearer …`; the handler rejects anything that doesn't match. |
| `POSTGRES_URL` | ✅ | Auto-added by the Postgres integration above |
| `RESEND_API_KEY` | optional | Enables email digests (see below) |
| `DIGEST_FROM` | optional | Verified sender, e.g. `USPTO Watch <alerts@yourdomain.com>` |
| `DIGEST_TO` | optional | Recipient(s), comma-separated |
| `APP_BASE_URL` | optional | Overrides the auto-detected site URL in email links |

> After adding/changing env vars, **redeploy** so the functions pick them up.

## 4. Deploy

Push this folder to a GitHub repo and **Import** it at https://vercel.com
(or run `vercel` from the folder with the CLI). On deploy, Vercel:

- serves `public/` as static,
- turns each file in `api/` into a serverless function,
- registers the cron from `vercel.json`.

Your site is live at `https://<project>.vercel.app`.

## How the daily cron works

`vercel.json` registers:

```json
"crons": [{ "path": "/api/cron/check-filings", "schedule": "0 9 * * *" }]
```

- Runs **once a day** (~09:00 **UTC** — Vercel runs crons in UTC; adjust the hour
  for your timezone). On the **Hobby plan**, daily is the max frequency, timing is
  approximate (within the hour), and there are no automatic retries.
- For each tracked application it pulls the current document list, inserts any
  `documentIdentifier` it hasn't seen before, and flags it `is_new = true`.
- When you **start tracking** an application, its *existing* documents are
  recorded as a baseline (`is_new = false`) so only **future** filings show up
  as new.
- New filings appear in the **"New Filings"** panel on the page; click
  **Mark all as seen** to clear them.

**Test the cron manually** (use your real secret):

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://<project>.vercel.app/api/cron/check-filings
```

### Want more frequent checks?

The Hobby plan caps crons at once-daily. To check more often, either upgrade to
Pro, or leave the route as-is and trigger it on your own schedule from a free
external scheduler (e.g. cron-job.org / GitHub Actions) by calling the URL above
with the `Authorization` header.

## Email digests (optional)

When a cron run finds new documents, it can email you a digest. It's **off by
default** and turns on automatically once these env vars are set:

1. Create a free account at https://resend.com and add an **API key**.
2. **Verify a sending domain** (or use Resend's `onboarding@resend.dev` sender
   for testing).
3. Set the env vars and redeploy:
   - `RESEND_API_KEY` — your Resend key
   - `DIGEST_FROM` — e.g. `USPTO Watch <alerts@yourdomain.com>` (must match a
     verified domain)
   - `DIGEST_TO` — recipient(s), comma-separated
   - `APP_BASE_URL` *(optional)* — only if the auto-detected URL for the download
     links in the email is wrong

The digest groups new documents by application and includes one-click download
links (pointing back at your `/api/document` proxy). If the email vars are unset,
the cron simply skips sending and you still get the in-app "New Filings" panel.
The cron's JSON response includes an `email` field showing `sent` / `skipped` /
`error` so you can confirm it's working from the manual `curl` test above.

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
