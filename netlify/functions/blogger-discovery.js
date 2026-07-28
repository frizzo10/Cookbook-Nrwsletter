// netlify/functions/blogger-discovery.js
// Covers TWO roadmap items in one pipeline, since they share the same
// blocker and naturally chain together:
//   - "Automated Blogger Discovery" (search + qualify candidate sites)
//   - "Automated Blogger Outreach Emails" (AI-draft a pitch)
//
// Discovery and drafting happen automatically; SENDING stays entirely
// manual. Drafts land in the same "content-queue" Blobs store the existing
// Facebook/Reddit items use (type: 'blogger_outreach'), so review/copy/send
// happens through the admin panel's existing Community Content Queue UI —
// nothing here ever emails anyone on its own. This sidesteps the sender-
// reputation risk flagged on the roadmap entirely (no auto-send = no risk
// to the newsletter's own domain reputation), rather than needing a
// separate outreach-only sending domain.
//
// REQUIRES (not yet configured — this function no-ops with a clear error
// until these exist): GOOGLE_SEARCH_API_KEY, GOOGLE_SEARCH_CX
// (Google Custom Search JSON API — free tier: 100 queries/day. Set up at
// https://programmablesearchengine.google.com/ + Google Cloud Console.)
import { getStore } from "@netlify/blobs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const SEARCH_QUERIES = [
  "food blog \"about me\" recipes contact",
  "home cooking blog recipes contact email",
  "recipe blogger \"work with me\"",
];

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
    } catch (e) { console.error("[blogger-discovery] Groq failed:", e.message); }
  }
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens, temperature: 0.6 } }),
      });
      const data = await res.json();
      return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    } catch (e) { console.error("[blogger-discovery] Gemini failed:", e.message); }
  }
  return "";
}

async function googleSearch(query) {
  const key = process.env.GOOGLE_SEARCH_API_KEY;
  const cx = process.env.GOOGLE_SEARCH_CX;
  if (!key || !cx) return { ok: false, error: "GOOGLE_SEARCH_API_KEY / GOOGLE_SEARCH_CX not configured" };
  try {
    const res = await fetch(`https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${encodeURIComponent(query)}&num=10`);
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error?.message || `HTTP ${res.status}` };
    return { ok: true, results: (data.items || []).map(i => ({ url: i.link, title: i.title, snippet: i.snippet })) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function extractEmail(html) {
  const mailtoMatch = html.match(/mailto:([^"'?\s]+)/i);
  if (mailtoMatch) return mailtoMatch[1];
  // Fallback: plain-text email pattern, skip obvious image/asset-filename false positives
  const textMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
  if (textMatch) {
    const real = textMatch.find(e => !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(e) && !e.includes("example.") && !e.includes("sentry") && !e.includes("wixpress"));
    return real || null;
  }
  return null;
}

async function fetchSiteAndEmail(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; FernBloggerDiscovery/1.0)" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { ok: false };
    const html = await res.text();
    const email = extractEmail(html);
    const textSnippet = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1500);
    return { ok: true, email, textSnippet };
  } catch {
    return { ok: false };
  }
}

async function fetchKnownBloggerUrls() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return new Set();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/bloggers?select=website_url,email`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) return new Set();
    const rows = await res.json();
    const set = new Set();
    rows.forEach(r => { if (r.website_url) set.add(r.website_url); if (r.email) set.add(r.email.toLowerCase()); });
    return set;
  } catch {
    return new Set();
  }
}

async function qualifyCandidate(title, snippet, textSnippet) {
  const prompt = `Is this a genuine, active individual food/recipe blog (not a corporate site, recipe aggregator, news outlet, or dead/spam page)?

Title: ${title}
Search snippet: ${snippet}
Page text sample: ${textSnippet.slice(0, 600)}

Reply with ONLY one word: YES or NO.`;
  const raw = await callAI(prompt, 10);
  return /^yes/i.test(raw.trim());
}

async function draftOutreach(title, url) {
  const prompt = `Write a short, genuine outreach email inviting a food blogger to join Fern's Blogger Cookbook program — a free platform where their recipes get real attribution, traffic back to their site, and they earn from engagement.

Blogger's site: ${title} (${url})

Tone: warm, specific, not a mass-blast template feel — like a real person who actually looked at their site. Keep it short (under 120 words). No excessive enthusiasm/exclamation points.

Return ONLY valid JSON, no markdown: {"subject": "under 60 chars", "body": "the email body, plain text with \\n\\n between paragraphs"}`;
  const raw = await callAI(prompt, 400);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch { return null; }
}

export default async (req) => {
  const headers = { "Content-Type": "application/json" };
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
  }

  if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_CX) {
    return new Response(JSON.stringify({
      error: "Not configured. This function needs GOOGLE_SEARCH_API_KEY and GOOGLE_SEARCH_CX (Google Custom Search JSON API — free tier, 100 queries/day). Set up at https://programmablesearchengine.google.com/ then add both as Netlify env vars.",
    }), { status: 500, headers });
  }

  const seenStore = getStore("blogger-discovered");
  const seen = (await seenStore.get("urls", { type: "json" }).catch(() => [])) || [];
  const seenSet = new Set(seen);
  const knownBloggers = await fetchKnownBloggerUrls();

  const candidates = [];
  for (const q of SEARCH_QUERIES) {
    const search = await googleSearch(q);
    if (!search.ok) continue;
    for (const r of search.results) {
      if (seenSet.has(r.url) || knownBloggers.has(r.url)) continue;
      candidates.push(r);
    }
  }

  const drafted = [];
  for (const c of candidates.slice(0, 15)) { // cap per run — stay well within search + AI quota
    const site = await fetchSiteAndEmail(c.url);
    if (!site.ok) { seenSet.add(c.url); continue; }
    if (site.email && knownBloggers.has(site.email.toLowerCase())) { seenSet.add(c.url); continue; }

    const qualifies = await qualifyCandidate(c.title, c.snippet, site.textSnippet || "");
    seenSet.add(c.url);
    if (!qualifies || !site.email) continue;

    const outreach = await draftOutreach(c.title, c.url);
    if (!outreach) continue;

    drafted.push({
      id: "blogger_" + Buffer.from(c.url).toString("base64").slice(0, 16),
      type: "blogger_outreach",
      group: site.email,
      title: c.title,
      draft: `Subject: ${outreach.subject}\n\n${outreach.body}`,
      source_url: c.url,
      created_at: new Date().toISOString(),
      status: "pending",
    });
  }

  await seenStore.setJSON("urls", Array.from(seenSet).slice(-2000)); // cap growth

  if (drafted.length > 0) {
    const cqStore = getStore("content-queue");
    const existing = (await cqStore.get("items", { type: "json" }).catch(() => [])) || [];
    const existingIds = new Set(existing.map(i => i.id));
    const trulyNew = drafted.filter(i => !existingIds.has(i.id));
    await cqStore.setJSON("items", [...trulyNew, ...existing].slice(0, 150));
  }

  return new Response(JSON.stringify({
    success: true,
    searched: candidates.length,
    checked: Math.min(candidates.length, 15),
    drafted: drafted.length,
  }), { headers });
};

export const config = { schedule: "0 10 * * 2" }; // Tuesdays 10am UTC
