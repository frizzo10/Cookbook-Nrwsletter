// netlify/functions/admin-api.js
import { getStore } from "@netlify/blobs";

async function verifyToken(token) {
  // Password protection removed entirely per explicit decision (2026-07-23) --
  // this admin panel is now intentionally public. No token check.
  // To restore protection later: revert this function to check the token
  // against the admin-sessions store, and revert admin.html's auto-login.
  return true;
}

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const token = url.searchParams.get("token") || (await req.json().catch(() => ({}))).token;

  if (!(await verifyToken(token))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  const subStore = getStore("subscribers");
  const nlStore = getStore("newsletters");

  // GET subscribers
  if (action === "subscribers") {
    const list = await subStore.get("list", { type: "json" }).catch(() => []);
    return new Response(JSON.stringify({ subscribers: list || [] }), { headers });
  }

  // GET stats
  if (action === "stats") {
    const list = await subStore.get("list", { type: "json" }).catch(() => []);
    const all = list || [];
    const active = all.filter(s => !s.unsubscribed);
    return new Response(JSON.stringify({
      total: all.length,
      active: active.length,
      confirmed: active.filter(s => s.confirmed).length,
      pending: active.filter(s => !s.confirmed).length,
      unsubscribed: all.filter(s => s.unsubscribed).length,
      diets: active.reduce((acc, s) => {
        const d = s.prefs?.diet || "omnivore";
        acc[d] = (acc[d] || 0) + 1;
        return acc;
      }, {}),
    }), { headers });
  }

  // GET security event log (Turnstile failures, rate limits, lockouts, etc.)
  if (action === "security-log") {
    const logStore = getStore("security-log");
    const events = (await logStore.get("events", { type: "json" }).catch(() => [])) || [];
    return new Response(JSON.stringify({ events }), { headers });
  }

  // GET system health — newsletter generation status + which integrations are configured
  if (action === "health") {
    const latest = await nlStore.get("latest", { type: "json" }).catch(() => null);
    const lastError = await nlStore.get("last_error", { type: "json" }).catch(() => null);
    return new Response(JSON.stringify({
      lastGeneration: latest ? { month: latest.month, year: latest.year, generatedAt: latest.generated_at || null } : null,
      lastError: lastError || null,
      config: {
        groq: !!process.env.GROQ_API_KEY,
        gemini: !!process.env.GEMINI_API_KEY,
        pexels: !!process.env.PEXELS_API_KEY,
        resend: !!process.env.RESEND_API_KEY,
        supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
        turnstile: !!(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY),
        adminAlertEmail: !!process.env.ADMIN_ALERT_EMAIL,
      },
    }), { headers });
  }

  // GET past issues list
  if (action === "issues") {
    const { blobs } = await nlStore.list().catch(() => ({ blobs: [] }));
    const issueKeys = (blobs || []).map(b => b.key).filter(k => k !== "latest" && k !== "last_error").sort().reverse();
    return new Response(JSON.stringify({ issues: issueKeys }), { headers });
  }

  // GET specific issue
  if (action === "issue") {
    const key = url.searchParams.get("key") || "latest";
    const nl = await nlStore.get(key, { type: "json" }).catch(() => null);
    return new Response(JSON.stringify({ newsletter: nl }), { headers });
  }

  // POST delete subscriber
  if (action === "delete-subscriber" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const list = await subStore.get("list", { type: "json" }).catch(() => []);
    const updated = (list || []).filter(s => s.email !== body.email);
    await subStore.setJSON("list", updated);
    return new Response(JSON.stringify({ success: true }), { headers });
  }

  // POST trigger generate
  if (action === "generate" && req.method === "POST") {
    const siteUrl = process.env.URL || "https://cookbookai1.netlify.app";
    const res = await fetch(`${siteUrl}/.netlify/functions/generate-newsletter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.CRON_SECRET }),
    });
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), { headers });
  }

  // POST trigger send
  if (action === "send" && req.method === "POST") {
    const siteUrl = process.env.URL || "https://cookbookai1.netlify.app";
    const res = await fetch(`${siteUrl}/.netlify/functions/send-newsletter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.CRON_SECRET }),
    });
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), { headers });
  }

  // POST trigger win-back batch (see send-winback.js — deliberately manual, not auto-cron)
  if (action === "winback" && req.method === "POST") {
    const siteUrl = process.env.URL || "https://cookbookai1.netlify.app";
    const res = await fetch(`${siteUrl}/.netlify/functions/send-winback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.CRON_SECRET }),
    });
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), { headers });
  }

  // POST trigger blogger discovery (search + qualify + draft outreach)
  if (action === "blogger-discovery" && req.method === "POST") {
    const siteUrl = process.env.URL || "https://cookbookai1.netlify.app";
    const res = await fetch(`${siteUrl}/.netlify/functions/blogger-discovery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.CRON_SECRET }),
    });
    const data = await res.json().catch(() => ({}));
    return new Response(JSON.stringify(data), { headers });
  }

  return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers });
};
