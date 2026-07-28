// netlify/functions/competitor-monitor.js
// Weekly digest of competitor pricing/feature pages. Fetches each page's
// HTML, strips it to plain text, diffs against last week's stored snapshot,
// and asks the AI to summarize what actually changed (rather than emailing
// raw text every week). Sent to ADMIN_ALERT_EMAIL.
//
// KNOWN LIMITATION: this is a plain fetch(), not a real browser — heavily
// JS-rendered pages (Instacart/Kroger's app shells especially) may return
// mostly boilerplate on first load. Marketing/pricing/help pages tend to be
// server-rendered enough to still carry real signal, but if a competitor's
// digest entry looks consistently empty/unchanged, that's why — worth
// revisiting with a real headless-browser fetch service if so.
import { getStore } from "@netlify/blobs";

const COMPETITORS = [
  { name: "Instacart", url: "https://www.instacart.com/pricing" },
  { name: "Kroger (Ship/ClickList)", url: "https://www.kroger.com/i/kroger-delivery-now-boost" },
  { name: "Cooklist", url: "https://www.cooklist.com" },
];

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSnapshot(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; FernCompetitorMonitor/1.0)" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    const text = stripHtml(html).slice(0, 8000);
    if (text.length < 200) return { ok: false, error: "Page returned too little text (likely JS-rendered shell)" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function callAI(prompt, maxTokens) {
  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${groqKey}` },
        body: JSON.stringify({
          model: "qwen/qwen3.6-27b",
          reasoning_effort: "none",
          max_tokens: maxTokens,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      const text = (data.choices?.[0]?.message?.content || "").trim();
      if (res.ok && text) return text;
    } catch (e) { console.error("[competitor-monitor] Groq failed:", e.message); }
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 } }),
      });
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    } catch (e) { console.error("[competitor-monitor] Gemini failed:", e.message); }
  }
  return "";
}

export default async (req) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const store = getStore("competitor-snapshots");
  const results = [];

  for (const comp of COMPETITORS) {
    const snap = await fetchSnapshot(comp.url);
    const key = comp.name.replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const prev = await store.get(key, { type: "json" }).catch(() => null);

    if (!snap.ok) {
      results.push({ name: comp.name, url: comp.url, ok: false, error: snap.error, summary: null });
      continue;
    }

    let summary;
    if (prev && prev.text) {
      const prompt = `Here is last week's snapshot of ${comp.name}'s page (${comp.url}), followed by this week's snapshot. Both are stripped plain text from the page HTML, so ignore navigation/footer noise.

LAST WEEK:
${prev.text.slice(0, 3000)}

THIS WEEK:
${snap.text.slice(0, 3000)}

In 2-3 sentences, summarize any meaningful changes relevant to a competing grocery-AI startup (pricing changes, new features, messaging changes, promotions). If nothing meaningfully changed, just say "No meaningful changes detected this week."`;
      summary = await callAI(prompt, 300) || "(AI summary unavailable this run)";
    } else {
      const prompt = `Here is plain text scraped from ${comp.name}'s page (${comp.url}):

${snap.text.slice(0, 3000)}

In 2-3 sentences, summarize what's notable here for a competing grocery-AI startup to know (pricing, key features, positioning). This is the first snapshot, so just describe current state.`;
      summary = await callAI(prompt, 300) || "(AI summary unavailable this run)";
    }

    await store.setJSON(key, { text: snap.text, checked_at: new Date().toISOString() });
    results.push({ name: comp.name, url: comp.url, ok: true, summary });
  }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.ADMIN_ALERT_EMAIL;
  if (key && to) {
    const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";
    const rows = results.map(r => `
      <div style="margin-bottom:18px;padding:14px 16px;background:#faf7f0;border-left:3px solid ${r.ok ? "#6dbf7e" : "#e07060"}">
        <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#1a1a1a">${r.name}</p>
        <p style="margin:0;font-size:14px;color:#555;line-height:1.6">${r.ok ? r.summary : `Couldn't check this week: ${r.error}`}</p>
        <p style="margin:8px 0 0"><a href="${r.url}" style="font-size:12px;color:#7fb3d5">${r.url}</a></p>
      </div>`).join("");

    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        from: `Fern Competitor Watch <${FROM}>`,
        to,
        subject: `Weekly competitor check — ${results.filter(r => r.ok).length}/${results.length} sources checked`,
        html: `<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;padding:32px 24px;background:#fffdf7;">
          <p style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#c8a96e;margin:0 0 6px">Weekly Competitor Monitor</p>
          <p style="font-size:13px;color:#999;margin:0 0 24px">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
          ${rows}
        </div>`,
      }),
    }).catch(e => console.error("[competitor-monitor] digest email failed:", e.message));
  }

  return new Response(JSON.stringify({ success: true, results }), { headers: { "Content-Type": "application/json" } });
};

export const config = { schedule: "0 9 * * 1" }; // Mondays 9am UTC
