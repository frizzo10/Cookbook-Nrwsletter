# The Cultured Table — Monthly Food Newsletter

Monthly newsletter covering food trends and recipes, written by Fern and auto-delivered by email.

## Architecture
- **Frontend**: `index.html` — editorial landing page showing latest issue
- **Functions**: Netlify serverless functions
- **Storage**: Netlify Blobs (newsletter content + subscriber list)
- **Email**: Resend (free tier covers ~3,000 emails/month)
- **AI**: Groq (Qwen) generates all content, written in Fern's voice, with Gemini as fallback
- **Schedule**: Auto-runs on the 1st of every month at 9am UTC

## Setup (One-time)

### 1. Connect repo to Netlify
- Push this repo to GitHub
- Import to Netlify (it will auto-detect `netlify.toml`)
- Set publish directory to `.` (root)

### 2. Enable Netlify Blobs
Blobs are enabled automatically when you use them — no config needed.

### 3. Set environment variables in Netlify
Go to **Site Settings → Environment Variables** and add:

| Variable | Value |
|----------|-------|
| `GROQ_API_KEY` | Your Groq API key (Qwen model) |
| `GEMINI_API_KEY` | Your Gemini API key (fallback if Groq fails) |
| `RESEND_API_KEY` | Your Resend API key (free at resend.com) |
| `FROM_EMAIL` | e.g. `newsletter@yourdomain.com` (must be verified in Resend) |
| `CRON_SECRET` | Any random string, e.g. `super-secret-cron-key-2024` |

### 4. Set up Resend (free email provider)
1. Sign up at https://resend.com (free: 3k emails/month, 100/day)
2. Add and verify your domain (or use their shared domain for testing)
3. Copy your API key → `RESEND_API_KEY`

### 5. Generate your first newsletter manually
After deploying, trigger the first issue:
```bash
curl -X POST https://cookbookai1.netlify.app/.netlify/functions/generate-newsletter \
  -H "Content-Type: application/json" \
  -d '{"secret": "YOUR_CRON_SECRET"}'
```

## How it works
1. **Monthly cron** fires on the 1st at 9am UTC
2. `generate-newsletter` asks Claude to write trends + 3 recipes as JSON
3. Result is stored in Netlify Blobs (key: `YYYY-MM` + `latest`)
4. `send-newsletter` loops through subscribers and emails each one via Resend
5. Frontend fetches `/get-newsletter` and renders the latest issue

## Subscriber management
- Subscribers sign up via the form on the homepage
- Each gets a welcome email with an unsubscribe token
- Unsubscribe link in every email → marks them as `unsubscribed: true`
- List stored in Netlify Blobs under key `subscribers/list`

## Growth Automations (added 2026-07-28)

Six of the eight "Buildable Now" items from the Growth Automation Roadmap, shipped:

| Automation | Function(s) | Schedule | Notes |
|---|---|---|---|
| Weekly Biggest Deals Digest | `generate-deals-digest.js`, `get-deals-digest.js` | Wed 8am UTC | Public page: `/deals.html`. Pulls recent `user_data.circular` rows from Fern's Supabase, AI writes it up. |
| Comparison/SEO Landing Pages | `generate-seo-pages.js`, `get-seo-page.js` | 1st of month, 7am UTC | Public pages: `/compare/<slug>` (instacart-alternative, avoid-grocery-delivery-fees, best-grocery-budgeting-app). Grounded in real Fern pricing facts hardcoded in the prompt — edit `KNOWN_FACTS` if pricing changes. |
| Inactive User Win-Back | `send-winback.js` | **Manual only** — admin panel "💌 Send Win-Back Batch" button | Deliberately not on cron since it emails real Fern users. Capped at 25/run, 45-day cooldown per user tracked in Blobs (`winback-sent` store). |
| Weekly Metrics Digest (internal) | `metrics-digest.js` | Mon 8am UTC | Emails `ADMIN_ALERT_EMAIL`. Signups/active users from Supabase, subscriber stats, content-queue backlog. |
| Weekly Competitor Monitor | `competitor-monitor.js` | Mon 9am UTC | Emails `ADMIN_ALERT_EMAIL`. Fetches Instacart/Kroger/Cooklist pages, AI diffs vs. last week's snapshot. Plain `fetch()`, not a real browser — heavily JS-rendered pages may return limited signal. |
| Reddit Opportunity Discovery Digest | `generate-content-queue.js` (existing, extended) | Mon/Thu 10am UTC (existing) | Was already discovering+drafting; added the actual email notification step (`sendDigestEmail`) to `ADMIN_ALERT_EMAIL` so new drafts don't rely on remembering to check the admin panel. |

| Blogger Spotlight Content | `blogger-spotlight.js`, `get-blogger-spotlight.js` | Fri 8am UTC | Public page: `/blogger-spotlight.html`. Features whichever active blogger leads on `total_saves` (falls back to top earner) from the new `bloggers` table. |
| Blogger Performance Digest | `blogger-digest.js` | 1st of month, 9am UTC | Emails every active blogger in the `bloggers` table their own real stats (recipes, saves, clicks, earnings). Separate audience from the newsletter subscriber list. |

## Blogger Discovery + Outreach (added 2026-07-28)

Covers two more roadmap items that shared the same blocker: **Automated Blogger Discovery** and **Automated Blogger Outreach Emails**, both handled by one pipeline (`blogger-discovery.js`, Tuesdays 10am UTC, or trigger manually via "🔍 Discover Bloggers Now" in the admin panel).

- Searches via Google Custom Search API, extracts a contact email from each candidate site, AI-qualifies whether it's a genuine active food blog, then AI-drafts a personalized outreach pitch.
- Drafts land in the **same Community Content Queue** as the Facebook/Reddit items (type: `blogger_outreach`) — reviewed and sent manually, exactly like those. This was a deliberate choice: it fully avoids the sender-reputation risk flagged on the roadmap for this item, since nothing here ever auto-sends.
- Dedupes against both already-discovered candidates and bloggers already in the `bloggers` table.

**Requires** (not yet configured — the function returns a clear error until these exist): `GOOGLE_SEARCH_API_KEY` and `GOOGLE_SEARCH_CX` — free tier via [Google Programmable Search Engine](https://programmablesearchengine.google.com/) (100 queries/day). Add both as Netlify env vars to activate.

All 8 "Buildable Now" items, plus these 2 "Blocked" items (built, waiting on the search API key), are now shipped.

No new env vars required — all six reuse `GROQ_API_KEY`, `GEMINI_API_KEY`, `RESEND_API_KEY`, `FROM_EMAIL`, `CRON_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and `ADMIN_ALERT_EMAIL`, all already configured on this site.
