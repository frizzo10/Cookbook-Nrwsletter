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
