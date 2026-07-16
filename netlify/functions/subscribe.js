// netlify/functions/subscribe.js
import { getStore } from "@netlify/blobs";
import crypto from "crypto";

async function logSecurityEvent(type, detail, ip) {
  try {
    const logStore = getStore("security-log");
    const events = (await logStore.get("events", { type: "json" }).catch(() => [])) || [];
    events.unshift({ type, detail, ip, timestamp: new Date().toISOString() });
    await logStore.setJSON("events", events.slice(0, 200));
  } catch (e) {
    console.error("[security-log] failed:", e.message);
  }
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured yet — don't hard-block signups
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, remoteip: ip }),
    });
    const data = await res.json();
    return !!data.success;
  } catch {
    return false;
  }
}

const VALID_DIETS = ["omnivore", "vegetarian", "vegan", "keto", "paleo", "mediterranean", "gluten-free"];
const VALID_SKILLS = ["beginner", "intermediate", "advanced"];
const VALID_ALLERGIES = ["nuts", "dairy", "eggs", "shellfish", "soy", "wheat"];

const RATE_LIMIT_MAX = 5; // max attempts
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // per hour, per IP

function getClientIp(req) {
  return req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const body = await req.json().catch(() => ({}));
  const ip = getClientIp(req);

  // ── Honeypot — real users never fill this hidden field; bots that
  // auto-fill every form field will, so silently pretend to succeed. ────
  if (body.website) {
    await logSecurityEvent("honeypot_triggered", body.email || "", ip);
    return new Response(JSON.stringify({ success: true, message: "Welcome aboard!" }), { headers });
  }

  // ── Turnstile — this is the real bot defense; honeypot + rate limits
  // only slow down unsophisticated automation. ─────────────────────────
  const turnstileOk = await verifyTurnstile(body.turnstileToken, ip);
  if (!turnstileOk) {
    await logSecurityEvent("turnstile_failed", "subscribe", ip);
    return new Response(JSON.stringify({ error: "Verification failed. Please try again." }), { status: 400, headers });
  }

  // ── Rate limit by IP ────────────────────────────────────────────────
  const rlStore = getStore("rate-limits");
  const rlKey = `subscribe:${ip}`;
  const rlData = await rlStore.get(rlKey, { type: "json" }).catch(() => null);
  const now = Date.now();
  if (rlData && rlData.count >= RATE_LIMIT_MAX && now - rlData.windowStart < RATE_LIMIT_WINDOW_MS) {
    await logSecurityEvent("rate_limit_blocked", "subscribe", ip);
    return new Response(JSON.stringify({ error: "Too many attempts. Please try again later." }), { status: 429, headers });
  }
  const newRlData = rlData && now - rlData.windowStart < RATE_LIMIT_WINDOW_MS
    ? { count: rlData.count + 1, windowStart: rlData.windowStart }
    : { count: 1, windowStart: now };
  await rlStore.setJSON(rlKey, newRlData);

  const email = (body.email || "").trim().toLowerCase();
  const name = (body.name || "").trim().replace(/<[^>]*>/g, "").slice(0, 60); // strip HTML tags, cap length

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers });
  }

  // ── Validate diet/skill/allergies against fixed allow-lists — these
  // values get fed into an AI prompt at send time, so free text here is
  // a prompt-injection surface, not just a data-quality issue. ─────────
  const diet = VALID_DIETS.includes(body.diet) ? body.diet : "omnivore";
  const skill = VALID_SKILLS.includes(body.skill) ? body.skill : "intermediate";
  const allergies = Array.isArray(body.allergies)
    ? body.allergies.filter((a) => VALID_ALLERGIES.includes(a)).slice(0, VALID_ALLERGIES.length)
    : [];
  const prefs = { diet, skill, allergies };

  const store = getStore("subscribers");
  const existing = await store.get("list", { type: "json" }).catch(() => []);
  const list = existing || [];

  const existingSub = list.find((s) => s.email === email);
  if (existingSub && !existingSub.unsubscribed) {
    if (existingSub.confirmed) {
      return new Response(JSON.stringify({ message: "Already subscribed!" }), { headers });
    }
    // Already pending confirmation — resend rather than create a duplicate.
  }

  const token = crypto.randomBytes(16).toString("hex");
  const confirmToken = crypto.randomBytes(16).toString("hex");

  if (existingSub) {
    Object.assign(existingSub, { name, prefs, token, confirmToken, confirmed: false, unsubscribed: false, resubscribed_at: new Date().toISOString() });
  } else {
    list.push({ email, name, prefs, token, confirmToken, confirmed: false, unsubscribed: false, subscribed_at: new Date().toISOString() });
  }
  await store.setJSON("list", list);

  // ── Send confirmation email (double opt-in) — subscriber is NOT added
  // to the real send list until they click this link. Without this,
  // anyone could enter a stranger's email and start sending them mail. ──
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";
  const SITE_URL = process.env.URL || "https://cookbookai1.netlify.app";
  const firstName = name.split(" ")[0] || "there";
  const confirmUrl = `${SITE_URL}/.netlify/functions/confirm-subscribe?email=${encodeURIComponent(email)}&token=${confirmToken}`;

  if (RESEND_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: `The Cultured Table <${FROM}>`,
        to: email,
        subject: "Confirm your subscription to The Cultured Table 🍽️",
        html: `<div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;padding:40px;background:#fffdf7;">
          <h1 style="font-size:26px;color:#1a1a1a;font-weight:400">One more step, ${firstName}</h1>
          <p style="color:#444;line-height:1.8">Please confirm your email to start receiving The Cultured Table — personalized monthly recipes and trends matched to your ${diet} diet and ${skill} cooking level.</p>
          <a href="${confirmUrl}" style="display:inline-block;margin-top:12px;background:#1C3A1A;color:#F0E0B0;padding:.7rem 1.6rem;border-radius:8px;text-decoration:none;font-weight:700">Confirm my subscription →</a>
          <p style="color:#999;font-size:13px;margin-top:28px">If you didn't request this, you can safely ignore this email — you won't be subscribed unless you click the link above.</p>
        </div>`,
      }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ success: true, message: `Almost there, ${firstName}! Check your email to confirm your subscription.` }), { headers });
};
