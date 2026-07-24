// netlify/functions/generate-content-queue.js
import { getStore } from "@netlify/blobs";

// ── AI: Groq (Qwen) primary, Gemini fallback ─────────────────────────
// Same pattern as generate-newsletter.js in this same project.
async function callGroqQwen(prompt, maxTokens) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false, error: "no GROQ_API_KEY configured" };
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "qwen/qwen3.6-27b",
        reasoning_effort: "none",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error?.message || `Groq error ${res.status}` };
    const msg = data.choices?.[0]?.message || {};
    const text = (msg.content && msg.content.trim()) || msg.reasoning || "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function callGeminiFallback(prompt, maxTokens) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { ok: false, error: "no GEMINI_API_KEY configured" };
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
        }),
      }
    );
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error?.message || `Gemini error ${res.status}` };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function callAI(prompt, maxTokens) {
  let r = await callGroqQwen(prompt, maxTokens);
  if (!r.ok || !r.text) r = await callGeminiFallback(prompt, maxTokens);
  return r;
}

// ── Coupons: unofficial Coupons.com wrapper via Parse.bot ────────────
// NOT an official Coupons.com integration -- Parse.bot reverse-engineers
// coupons.com's own internal API calls. Used deliberately here as a
// testing-stage data source (see roadmap notes for the full risk
// tradeoff). Requires PARSE_API_KEY in Netlify env vars -- if it's not
// set, this returns an empty array and content generation falls back
// to generic (no coupon examples), never breaks the batch.
const PARSE_BOT_SCRAPER_ID = "cffeaf1e-b13f-42de-9478-4188b90d83ae"; // Coupons.com API on Parse.bot -- verify against your own dashboard if this ever 404s, marketplace IDs can differ from call IDs
const GROCERY_KEYWORDS = ["grocery", "food", "snack", "dairy", "beverage", "frozen", "meat", "produce", "household", "coffee", "cereal"];

async function fetchGroceryCoupons() {
  const key = process.env.PARSE_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(`https://api.parse.bot/scraper/${PARSE_BOT_SCRAPER_ID}/get_top_coupons`, {
      headers: { "X-API-Key": key },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const offers = data.top_offers || data.offers || [];
    // Loosely filter toward grocery/CPG-relevant offers where a category is present;
    // if no category field exists on this response shape, just take what's returned.
    const filtered = offers.filter((o) => {
      const cat = (o.category_description || o.description || o.title || "").toLowerCase();
      return GROCERY_KEYWORDS.some((kw) => cat.includes(kw)) || !o.category_description;
    });
    return (filtered.length ? filtered : offers).slice(0, 5);
  } catch (e) {
    console.error("[content-queue] coupon fetch failed:", e.message);
    return [];
  }
}


// ── Facebook: evergreen drafts (no API access exists to monitor these
// groups, so this generates fresh ready-to-paste posts on a cadence
// instead of replying to anything specific) ──────────────────────────
const FB_GROUPS = [
  { name: "The Krazy Coupon Lady", angle: "grocery + drugstore coupon matchups" },
  { name: "Grocery Coupon Games", angle: "grocery-focused deal matching" },
  { name: "Digital Coupon Deals", angle: "Ibotta / Checkout 51 / store-app coupons" },
];

async function generateFbDrafts(coupons) {
  const hasCoupons = coupons && coupons.length > 0;
  const couponContext = hasCoupons
    ? `\n\nReal current coupons to optionally reference (use at most one, only if it fits naturally, and describe it accurately -- don't invent details beyond what's given):\n${coupons.slice(0, 5).map(c => `- ${c.brand || c.retailer_name || c.title || 'Offer'}: ${c.value || c.description || ''}`).join("\n")}`
    : "";

  const prompt = `Write 2 short, genuine, non-salesy Facebook posts (60-90 words each) that a real solo indie founder could post in grocery-deal-hunting Facebook groups.

Context: I built Fern, an app that scans a grocery store's weekly sale circular (just a photo) and instantly turns the deals into AI-generated recipes and a shopping list -- so you plan meals around what's actually on sale instead of guessing.${couponContext}

Rules: sound like a real person sharing something they made, not an ad. No emoji spam, no "check out my app!!" energy, no exclamation-point overload. It's fine to mention the app by name once per post. Vary the angle between the two posts (one about saving money specifically, one about meal-planning stress/mental load).

Return ONLY valid JSON, no markdown fences, no commentary: {"posts":[{"angle":"...","text":"..."},{"angle":"...","text":"..."}]}`;

  const r = await callAI(prompt, 700);
  if (!r.ok || !r.text) return [];
  try {
    const clean = r.text.replace(/```json|```/g, "").trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : clean);
    return (parsed.posts || []).map((p, i) => ({
      id: "fb_" + Date.now() + "_" + i,
      type: "fb",
      group: FB_GROUPS[i % FB_GROUPS.length].name,
      title: p.angle || "Facebook post",
      draft: p.text || "",
      source_url: null,
      created_at: new Date().toISOString(),
      status: "pending",
    })).filter(item => item.draft);
  } catch (e) {
    console.error("[content-queue] FB draft JSON parse failed:", e.message, r.text?.slice(0, 200));
    return [];
  }
}

// ── Reddit: real opportunity discovery via Reddit's public read-only
// search JSON endpoint (no OAuth app registered yet -- this works for
// light use but is more fragile/rate-limited than a real API key would
// be; if this starts failing, registering a free Reddit API app and
// switching to authenticated requests is the fix). Posting stays
// entirely manual -- this only ever reads. ─────────────────────────
async function searchReddit(query) {
  try {
    const url = `https://www.reddit.com/r/Frugal/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=5&t=week`;
    const res = await fetch(url, {
      headers: { "User-Agent": "web:fern-content-queue:v1.0 (by /u/fernai_app)" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data?.children || []).map((c) => c.data);
  } catch (e) {
    console.error("[content-queue] Reddit search failed:", e.message);
    return [];
  }
}

async function generateRedditDrafts() {
  const queries = ["meal plan grocery", "weekly ad savings", "grocery budget"];
  let allThreads = [];
  for (const q of queries) {
    const threads = await searchReddit(q);
    allThreads = allThreads.concat(threads);
  }
  const seen = new Set();
  const unique = allThreads
    .filter((t) => t && t.id && !seen.has(t.id) && (seen.add(t.id), true))
    .slice(0, 3);

  const drafts = [];
  for (const thread of unique) {
    const prompt = `A Reddit user in r/Frugal posted this:
Title: "${thread.title}"
Body: "${(thread.selftext || "").slice(0, 500)}"

Write a genuinely helpful reply (60-100 words) that directly answers what they're asking, from someone knowledgeable about grocery budgeting and meal planning. Only mention that you built an app (Fern -- scans store circulars into AI recipes/shopping lists) if it's a natural, non-pushy fit for this specific post; most of the time, just be helpful with no mention of it at all. Sound like a real Reddit comment, not marketing copy.

Return ONLY the reply text, nothing else -- no quotes around it, no preamble.`;

    const r = await callAI(prompt, 300);
    if (r.ok && r.text) {
      drafts.push({
        id: "reddit_" + thread.id,
        type: "reddit",
        group: "r/Frugal",
        title: thread.title,
        draft: r.text.trim(),
        source_url: `https://www.reddit.com${thread.permalink}`,
        created_at: new Date().toISOString(),
        status: "pending",
      });
    }
  }
  return drafts;
}

export default async (req) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers });
  }

  try {
    const coupons = await fetchGroceryCoupons();
    const [fbDrafts, redditDrafts] = await Promise.all([generateFbDrafts(coupons), generateRedditDrafts()]);
    const newItems = [...fbDrafts, ...redditDrafts];

    const store = getStore("content-queue");
    const existing = (await store.get("items", { type: "json" }).catch(() => [])) || [];
    // De-dupe against existing (Reddit items are keyed by real thread id, so
    // re-running won't duplicate a thread already queued)
    const existingIds = new Set(existing.map((i) => i.id));
    const trulyNew = newItems.filter((i) => !existingIds.has(i.id));
    const merged = [...trulyNew, ...existing].slice(0, 150); // sane cap
    await store.setJSON("items", merged);

    return new Response(
      JSON.stringify({ success: true, generated: trulyNew.length, fb: fbDrafts.length, reddit: redditDrafts.length, coupons_used: coupons.length }),
      { headers }
    );
  } catch (e) {
    console.error("[content-queue] generation failed:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};
