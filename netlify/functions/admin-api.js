// netlify/functions/admin-api.js
import { getStore } from "@netlify/blobs";
import crypto from "crypto";

function verifyToken(token) {
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";
  const today = new Date().toISOString().slice(0, 10);
  const expected = crypto.createHmac("sha256", ADMIN_PASSWORD).update(today).digest("hex");
  return token === expected;
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

  if (!verifyToken(token)) {
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
    return new Response(JSON.stringify({
      total: all.length,
      active: all.filter(s => !s.unsubscribed).length,
      unsubscribed: all.filter(s => s.unsubscribed).length,
      diets: all.filter(s => !s.unsubscribed).reduce((acc, s) => {
        const d = s.prefs?.diet || "omnivore";
        acc[d] = (acc[d] || 0) + 1;
        return acc;
      }, {}),
    }), { headers });
  }

  // GET past issues list
  if (action === "issues") {
    const { keys } = await nlStore.list().catch(() => ({ keys: [] }));
    const issueKeys = (keys || []).filter(k => k.name !== "latest").map(k => k.name).sort().reverse();
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

  return new Response(JSON.stringify({ error: "Unknown action" }), { status: 400, headers });
};
