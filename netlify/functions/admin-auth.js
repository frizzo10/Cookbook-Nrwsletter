// netlify/functions/admin-auth.js
import crypto from "crypto";
import { getStore } from "@netlify/blobs";

const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

function getClientIp(req) {
  return req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return true; // not configured yet — don't hard-block
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

async function alertOnLockout(ip) {
  const alertEmail = process.env.ADMIN_ALERT_EMAIL;
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";
  if (!alertEmail || !RESEND_KEY) return; // not configured — skip silently
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: `The Cultured Table Alerts <${FROM}>`,
        to: alertEmail,
        subject: "⚠️ Admin login locked out after repeated failed attempts",
        html: `<p>An IP address (${ip}) was just locked out of the admin panel after ${MAX_ATTEMPTS} failed password attempts within 15 minutes.</p><p>If this wasn't you, someone may be trying to guess your admin password.</p>`,
      }),
    });
  } catch (e) {
    console.error("[admin-auth] Failed to send lockout alert:", e.message);
  }
}

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  // Fail closed — no default password. If this isn't set, nobody gets in,
  // rather than silently falling back to a guessable literal "admin".
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD1;
  if (!ADMIN_PASSWORD) {
    console.error("[admin-auth] ADMIN_PASSWORD1 is not set — refusing all logins");
    return new Response(JSON.stringify({ error: "Admin login is not configured." }), { status: 503, headers });
  }

  const ip = getClientIp(req);
  const lockStore = getStore("admin-lockout");
  const lockKey = `attempts:${ip}`;
  const lockData = await lockStore.get(lockKey, { type: "json" }).catch(() => null);
  const now = Date.now();

  if (lockData && lockData.count >= MAX_ATTEMPTS && now - lockData.windowStart < LOCKOUT_WINDOW_MS) {
    return new Response(JSON.stringify({ error: "Too many failed attempts. Try again later." }), { status: 429, headers });
  }

  const { password, turnstileToken } = await req.json().catch(() => ({}));

  const turnstileOk = await verifyTurnstile(turnstileToken, ip);
  if (!turnstileOk) {
    return new Response(JSON.stringify({ error: "Verification failed. Please try again." }), { status: 400, headers });
  }

  if (password !== ADMIN_PASSWORD) {
    const newLockData = lockData && now - lockData.windowStart < LOCKOUT_WINDOW_MS
      ? { count: lockData.count + 1, windowStart: lockData.windowStart }
      : { count: 1, windowStart: now };
    await lockStore.setJSON(lockKey, newLockData);
    if (newLockData.count === MAX_ATTEMPTS) {
      await alertOnLockout(ip);
    }
    return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers });
  }

  // Success — clear any lockout counter for this IP
  await lockStore.delete(lockKey).catch(() => {});

  // Random per-session token, not a deterministic hash anyone with the
  // password could recompute — stored server-side with a real expiry.
  const token = crypto.randomBytes(32).toString("hex");
  const sessionStore = getStore("admin-sessions");
  await sessionStore.setJSON(token, { createdAt: now, expiresAt: now + SESSION_TTL_MS });

  return new Response(JSON.stringify({ success: true, token }), { headers });
};
