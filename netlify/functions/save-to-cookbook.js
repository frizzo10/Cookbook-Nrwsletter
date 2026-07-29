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
  }).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json().catch(() => null) }));
}

async function findFernUser(email) {
  // THE REAL BUG: Supabase's admin users endpoint does NOT support
  // server-side filtering by the ?email= query param -- this is a
  // documented, longstanding Supabase limitation (see
  // github.com/supabase/supabase/issues/29832). The old code here sent
  // ?email=<address> and just grabbed users[0] from whatever came back,
  // which is the FIRST user in the whole project by default pagination
  // order -- completely ignoring the email that was actually submitted.
  // Every "successful" save was very likely writing into a different,
  // essentially random Fern account, not the one whose email was entered.
  // Fixed by paginating through all users and matching client-side,
  // exact + case-insensitive, same safe pattern already used in
  // metrics-digest.js in this repo.
  const target = email.trim().toLowerCase();
  let page = 1;
  const perPage = 1000;
  const maxPages = 10; // safety cap, matches metrics-digest.js
  while (page <= maxPages) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) {
      console.error("[save-to-cookbook] findFernUser: admin users fetch failed:", res.status);
      return null;
    }
    const data = await res.json();
    const users = data.users || [];
    const match = users.find(u => (u.email || "").trim().toLowerCase() === target);
    if (match) return match;
    if (users.length < perPage) break; // last page
    page++;
  }
  return null;
}

async function doSave(userId, recipe) {
  // Was previously: supaFetch resolved with just the parsed body, no status
  // check anywhere -- a failed Supabase write (bad FK, RLS, schema
  // mismatch, anything) looked identical to a successful one, and this
  // function always returned as if the save worked. Now checks both calls
  // and throws a real error on failure, which the handler below turns into
  // an actual error response instead of a false "saved!" message.
  const getRes = await supaFetch("GET", `/rest/v1/user_data?user_id=eq.${userId}&limit=1`);
  if (!getRes.ok) {
    throw new Error("Could not load your Fern data: " + (getRes.body?.message || `status ${getRes.status}`));
  }
  const row = getRes.body?.[0] || {};
  const currentSaved = row.saved || [];
  const currentBooks = row.books || [];

  // THE REAL BUG: this used to push a raw recipe object directly into
  // `books`. In Fern's actual schema (confirmed against the main app's own
  // save-recipe flow), `books` holds named COOKBOOK COLLECTIONS --
  // {id, name, created} -- not individual recipes at all. Individual saved
  // recipes live in a separate `saved` array, each one linked to a cookbook
  // via a `_bookId` field. That's why the write always reported success
  // (Supabase happily stores whatever shape you send to a jsonb column) but
  // the recipe never showed up anywhere in the app -- it was sitting in the
  // wrong array, in the wrong shape, and the Cookbooks page had no reason
  // to ever look at it.
  let defaultBook = currentBooks.find((b) => b.name === "My Recipes");
  const updatedBooks = defaultBook ? currentBooks : [...currentBooks, (defaultBook = { id: "cb_" + Date.now(), name: "My Recipes", created: new Date().toLocaleDateString() })];

  const title = String(recipe.name || "").slice(0, 200);
  const alreadySaved = currentSaved.some((r) => r.title === title);
  if (alreadySaved) return { alreadySaved: true, title };

  const newRecipe = {
    _id: `newsletter_${Date.now()}`,
    _bookId: defaultBook.id,
    _cuisine: "",
    _mealType: "",
    _saved: new Date().toLocaleDateString(),
    title,
    description: String(recipe.description || "").slice(0, 2000),
    ingredients: Array.isArray(recipe.ingredients) ? recipe.ingredients.slice(0, 60).map(i => String(i).slice(0, 300)) : [],
    instructions: Array.isArray(recipe.instructions) ? recipe.instructions.slice(0, 60).map(i => String(i).slice(0, 1000)) : [],
    prepTime: String(recipe.prep_time || "").slice(0, 50),
    cookTime: String(recipe.cook_time || "").slice(0, 50),
    servings: Number.isFinite(+recipe.servings) ? +recipe.servings : 4,
    tip: String(recipe.tip || "").slice(0, 500),
    source: "The Cultured Table Newsletter",
    tags: ["newsletter", "cultured-table"],
  };

  const updatedSaved = [...currentSaved, newRecipe];
  const postRes = await supaFetch("POST", "/rest/v1/user_data?on_conflict=user_id", {
    user_id: userId,
    saved: updatedSaved,
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
  if (!postRes.ok) {
    throw new Error("Save failed: " + (postRes.body?.message || `status ${postRes.status}`));
  }
  return { alreadySaved: false, title };
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
    console.log("[save-to-cookbook] DIAGNOSTIC verify attempt:", JSON.stringify({
      email,
      submittedCode: String(code).trim(),
      pendingFound: !!pending,
      pendingCode: pending ? pending.code : null,
      pendingExpires: pending ? new Date(pending.expires).toISOString() : null,
      now: new Date().toISOString(),
      expired: pending ? Date.now() > pending.expires : null,
      pendingRecipeTitle: pending?.recipe?.name || null,
    }));
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
    let result;
    try {
      result = await doSave(user.id, pending.recipe);
    } catch (e) {
      console.error("[save-to-cookbook] doSave failed:", e.message);
      return new Response(JSON.stringify({ error: "We verified your code, but saving the recipe failed. Please try again." }), { status: 502, headers });
    }
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
  console.log("[save-to-cookbook] DIAGNOSTIC code generated:", JSON.stringify({
    email,
    code: verifyCode,
    expiresAt: new Date(Date.now() + CODE_TTL_MS).toISOString(),
    recipeTitle: recipe?.name || null,
  }));

  // Was previously: fire the Resend request, swallow any failure with
  // .catch(()=>{}), never check the response for an error -- then
  // unconditionally tell the user "we sent a code" regardless of what
  // actually happened. If RESEND_API_KEY was missing, or Resend rejected
  // the send (bad from-domain, rate limit, invalid recipient, etc.), the
  // user got told it worked with nothing to explain why nothing arrived.
  // Now actually checks the send succeeded before claiming it did.
  if (!RESEND_KEY) {
    console.error("[save-to-cookbook] RESEND_API_KEY not configured -- cannot send verification code");
    return new Response(
      JSON.stringify({ error: "Email delivery isn't configured right now. Please try again later or contact support." }),
      { status: 500, headers }
    );
  }

  let sendOk = false;
  let sendErrDetail = "";
  try {
    const resendRes = await fetch("https://api.resend.com/emails", {
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
    });
    if (resendRes.ok) {
      sendOk = true;
    } else {
      const errBody = await resendRes.json().catch(() => ({}));
      sendErrDetail = errBody.message || `Resend returned status ${resendRes.status}`;
    }
  } catch (e) {
    sendErrDetail = e.message;
  }

  if (!sendOk) {
    console.error("[save-to-cookbook] Resend send failed:", sendErrDetail);
    await pendingStore.delete(email).catch(() => {});
    return new Response(
      JSON.stringify({ error: "We couldn't send the verification email. Please try again in a moment." }),
      { status: 502, headers }
    );
  }

  return new Response(
    JSON.stringify({ needsVerification: true, message: `We sent a code to ${email}. Enter it below to finish saving.` }),
    { headers }
  );
};
