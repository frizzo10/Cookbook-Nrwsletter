// netlify/functions/send-winback.js
// Sends a win-back email to Fern users whose user_data row hasn't been
// touched in a while. DELIBERATELY NOT on an automatic cron — this emails
// real Fern app users, which is a bigger action than the other internal/
// newsletter-only automations in this file, so it's triggered manually from
// the admin panel (action=winback in admin-api.js) rather than firing
// unattended. Safe to re-run: each user only gets one win-back email per
// COOLDOWN_DAYS, tracked in Blobs so repeated runs don't spam the same
// person every week.
import { getStore } from "@netlify/blobs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const INACTIVE_DAYS = 21;   // hasn't touched the app in this long
const COOLDOWN_DAYS = 45;   // don't re-send to the same user within this window
const BATCH_CAP = 25;       // max emails per run — keeps this from ever mass-blasting unreviewed

async function callAI(prompt, maxTokens) {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({ model: "qwen/qwen3.6-27b", reasoning_effort: "none", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      const text = (data.choices?.[0]?.message?.content || "").trim();
      if (res.ok && text) return text;
    } catch (e) { console.error("[winback] Groq failed:", e.message); }
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 } }),
      });
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    } catch (e) { console.error("[winback] Gemini failed:", e.message); }
  }
  return "";
}

async function fetchInactiveUsers() {
  const cutoff = new Date(Date.now() - INACTIVE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/user_data?select=user_id,updated_at&updated_at=lt.${encodeURIComponent(cutoff)}&order=updated_at.asc&limit=200`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase user_data query failed: ${res.status}`);
  return res.json();
}

async function getUserEmail(userId) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.email || null;
  } catch {
    return null;
  }
}

async function generateWinbackCopy() {
  const prompt = `Write a short, warm win-back email for Fern, an app that scans grocery store sale circulars and turns them into AI recipes and a shopping list. The recipient hasn't opened the app in a few weeks.

Tone: genuinely warm, not desperate or salesy, like a friendly nudge rather than a marketing blast. Mention one concrete reason to come back (e.g. "this week's sales are already scanned and waiting" style framing, kept generic since we don't know their specific store).

Return ONLY valid JSON, no markdown: {"subject": "under 60 chars", "body_html": "2-3 short paragraphs as HTML <p> tags, warm and brief"}`;
  const raw = await callAI(prompt, 500);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Win-back copy generation returned no JSON");
  return JSON.parse(jsonMatch[0]);
}

export default async (req) => {
  const headers = { "Content-Type": "application/json" };
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const body = await req.json().catch(() => ({}));
  if (body.secret !== process.env.CRON_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: "Supabase not configured" }), { status: 500, headers });
  }

  try {
    const inactiveRows = await fetchInactiveUsers();
    const sentStore = getStore("winback-sent");
    const cooldownCutoff = Date.now() - COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

    const eligible = [];
    for (const row of inactiveRows) {
      const lastSent = await sentStore.get(row.user_id, { type: "json" }).catch(() => null);
      if (lastSent && new Date(lastSent.sent_at).getTime() > cooldownCutoff) continue;
      eligible.push(row);
      if (eligible.length >= BATCH_CAP) break;
    }

    if (eligible.length === 0) {
      return new Response(JSON.stringify({ success: true, sent: 0, message: "No eligible inactive users this run (either none inactive, or all within cooldown)." }), { headers });
    }

    const copy = await generateWinbackCopy();
    const key = process.env.RESEND_API_KEY;
    const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";
    if (!key) return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500, headers });

    let sent = 0, skippedNoEmail = 0, failed = 0;
    for (const row of eligible) {
      const email = await getUserEmail(row.user_id);
      if (!email) { skippedNoEmail++; continue; }

      const html = `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fffdf7;">
        <p style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#c8922a;margin:0 0 16px">🌿 Fern</p>
        ${copy.body_html}
        <p style="margin:24px 0 0"><a href="https://app.clickpickandcook.com" style="display:inline-block;background:#1C3A1A;color:#F0E0B0;padding:.6rem 1.3rem;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">Open Fern →</a></p>
      </div>`;

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ from: `Fern <${FROM}>`, to: email, subject: copy.subject, html }),
      }).catch(() => null);

      if (res && res.ok) {
        sent++;
        await sentStore.setJSON(row.user_id, { sent_at: new Date().toISOString() });
      } else {
        failed++;
      }
    }

    return new Response(JSON.stringify({ success: true, sent, skippedNoEmail, failed, batchSize: eligible.length }), { headers });
  } catch (e) {
    console.error("[winback] failed:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};

// NOTE: intentionally no `export const config = { schedule: ... }` here —
// see file header. Trigger manually via the admin panel.
