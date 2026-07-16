// netlify/functions/admin-auth.js
import crypto from "crypto";
import { getStore } from "@netlify/blobs";

const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

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

  const { password } = await req.json().catch(() => ({}));

  if (password !== ADMIN_PASSWORD) {
    const newLockData = lockData && now - lockData.windowStart < LOCKOUT_WINDOW_MS
      ? { count: lockData.count + 1, windowStart: lockData.windowStart }
      : { count: 1, windowStart: now };
    await lockStore.setJSON(lockKey, newLockData);
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
