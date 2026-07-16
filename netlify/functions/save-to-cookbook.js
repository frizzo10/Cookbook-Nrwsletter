// netlify/functions/save-to-cookbook.js
// Looks up user by email in Supabase, appends recipe to their books array.
//
// SECURITY: this now requires a one-time verification code sent to the
// email before anything is written. Previously, anyone who knew (or
// guessed) a Fern account's email could inject arbitrary recipe content
// into that account with zero proof of ownership. Now it's a two-step
// flow: (1) request a code, (2) submit the code to actually save.

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

function getClientIp(req) {
  return req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";
const CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function supaFetch(method, path, body) {
  const url = SUPABASE_URL + path;
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

async function findFernUser(email) {
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  }).then((r) => r.json());
  return authRes?.users?.[0] || null;
}

async function doSave(userId, recipe) {
  const rows = await supaFetch("GET", `/rest/v1/user_data?user_id=eq.${userId}&limit=1`);
  const row = rows?.[0] || {};
  const currentBooks = row.books || [];

  const newRecipe = {
    _id: `newsletter_${Date.now()}`,
    title: String(recipe.name || "").slice(0, 200),
    description: String(recipe.description || "").slice(0, 2000),
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60).map(i => String(i).slice(0, 300)) : [],
    instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60).map(i => String(i).slice(0, 1000)) : [],
    prepTime: String(recipe.prep_time || "").slice(0, 50),
    cookTime: String(recipe.cook_time || "").slice(0, 50),
    servings: Number.isFinite(+recipe.servings) ? +recipe.servings : 4,
    tip: String(recipe.tip || "").slice(0, 500),
    source: "The Cultured Table Newsletter",
    saved_at: new Date().toISOString(),
    tags: ["newsletter", "cultured-table"],
  };

  const alreadySaved = currentBooks.some((b) => b.title === newRecipe.title);
  if (alreadySaved) return { alreadySaved: true, title: newRecipe.title };

  const updatedBooks = [...currentBooks, newRecipe];
  await supaFetch("POST", "/rest/v1/user_data?on_conflict=user_id", {
    user_id: userId,
    saved: row.saved || [],
    books: updatedBooks,
    meal_plan: row.meal_plan || {},
    shopping: row.shopping || [],
    remi_explicit: row.remi_explicit || {},
    remi_learned: row.remi_learned || {},
    followed_bloggers: row.followed_bloggers || [],
    user_stores: row.user_stores || [],
    circular: row.circular || [],
    activities: row.activities || [],
    updated_at: new Date().toISOString(),
  });
  return { alreadySaved: false, title: newRecipe.title };
}

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const { email: rawEmail, recipe, code, turnstileToken } = await req.json().catch(() => ({}));
  const email = (rawEmail || "").trim().toLowerCase();
  const ip = getClientIp(req);

  if (!email || !recipe || !recipe.name) {
    return new Response(JSON.stringify({ error: "Missing email or recipe" }), { status: 400, headers });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers });
  }

  // Turnstile only required to request a code (step 1) — that's the action
  // that's cheap to spam and would flood someone's inbox. Submitting the
  // code itself (step 2) is already capped at 5 attempts.
  if (!code) {
    const turnstileOk = await verifyTurnstile(turnstileToken, ip);
    if (!turnstileOk) {
      await logSecurityEvent("turnstile_failed", "save_to_cookbook", ip);
      return new Response(JSON.stringify({ error: "Verification failed. Please try again." }), { status: 400, headers });
    }
  }

  const user = await findFernUser(email);
  if (!user) {
    return new Response(
      JSON.stringify({ error: "No Fern account found for that email. Download the app first at app.clickpickandcook.com" }),
      { status: 404, headers }
    );
  }

  const pendingStore = getStore("pending-saves");

  // ── Step 2: code provided — verify and actually save ──────────────
  if (code) {
    const pending = await pendingStore.get(email, { type: "json" }).catch(() => null);
    if (!pending || Date.now() > pending.expires) {
      return new Response(JSON.stringify({ error: "That code is invalid or expired. Request a new one." }), { status: 401, headers });
    }
    // Cap guesses — without this, the 6-digit code is brute-forceable
    // within its 15-minute window via a simple script loop.
    const attempts = (pending.attempts || 0) + 1;
    if (attempts > 5) {
      await pendingStore.delete(email).catch(() => {});
      await logSecurityEvent("code_bruteforce_blocked", email, ip);
      return new Response(JSON.stringify({ error: "Too many incorrect attempts. Request a new code." }), { status: 429, headers });
    }
    if (pending.code !== String(code).trim()) {
      await pendingStore.setJSON(email, { ...pending, attempts });
      return new Response(JSON.stringify({ error: "That code is invalid or expired. Request a new one." }), { status: 401, headers });
    }
    const result = await doSave(user.id, pending.recipe);
    await pendingStore.delete(email).catch(() => {});
    return new Response(
      JSON.stringify({
        success: true,
        message: result.alreadySaved ? "Already in your cookbook!" : `"${result.title}" saved to your Fern cookbook! Open the app to see it.`,
      }),
      { headers }
    );
  }

  // ── Step 1: no code yet — send a verification code ────────────────
  const verifyCode = String(crypto.randomInt(100000, 999999));
  await pendingStore.setJSON(email, { code: verifyCode, recipe, expires: Date.now() + CODE_TTL_MS });

  if (RESEND_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
      body: JSON.stringify({
        from: `The Cultured Table <${FROM}>`,
        to: email,
        subject: `Your code: ${verifyCode}`,
        html: `<div style="font-family:Georgia,serif;max-width:420px;margin:0 auto;padding:32px;background:#fffdf7;">
          <p style="color:#444;line-height:1.7">Enter this code to save "${String(recipe.name).slice(0, 100)}" to your Fern cookbook:</p>
          <p style="font-size:32px;font-weight:700;letter-spacing:.1em;color:#1C3A1A;margin:16px 0">${verifyCode}</p>
          <p style="color:#999;font-size:13px">This code expires in 15 minutes. If you didn't request this, you can ignore it.</p>
        </div>`,
      }),
    }).catch(() => {});
  }

  return new Response(
    JSON.stringify({ needsVerification: true, message: `We sent a code to ${email}. Enter it below to finish saving.` }),
    { headers }
  );
};
