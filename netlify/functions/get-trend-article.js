// netlify/functions/get-trend-article.js
import { getStore } from "@netlify/blobs";

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

const RATE_LIMIT_MAX = 20; // max article generations per IP per window
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function getClientIp(req) {
  return req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

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

async function generateText(prompt, maxTokens) {
  const primary = await callGroqQwen(prompt, maxTokens);
  if (primary.ok && primary.text.trim()) return primary.text;
  console.error("[get-trend-article] Qwen failed (" + (primary.error || "empty") + "), falling back to Gemini");
  const fallback = await callGeminiFallback(prompt, maxTokens);
  if (fallback.ok && fallback.text.trim()) return fallback.text;
  throw new Error(`Both Qwen and Gemini failed. Qwen: ${primary.error || "empty response"}. Gemini: ${fallback.error || "empty response"}.`);
}

async function fetchPexelsImage(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=8&orientation=landscape`,
      { headers: { Authorization: key } }
    );
    const data = await res.json();
    const photos = data.photos || [];
    if (!photos.length) return null;
    const best = photos.reduce((prev, curr) => {
      const pr = prev.width / prev.height;
      const cr = curr.width / curr.height;
      return Math.abs(cr - 1.5) < Math.abs(pr - 1.5) ? curr : prev;
    });
    return { url: best.src.large, photographer: best.photographer, photographer_url: best.photographer_url };
  } catch (e) {
    console.error("Pexels error:", e.message);
    return null;
  }
}

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });

  const url = new URL(req.url);
  const issueKey = url.searchParams.get("key") || "";
  const trendIndex = parseInt(url.searchParams.get("trendIndex"));

  if (!issueKey || isNaN(trendIndex) || trendIndex < 0 || trendIndex > 10) {
    return new Response(JSON.stringify({ error: "Missing or invalid key/trendIndex" }), { status: 400, headers });
  }

  // ── Rate limit by IP — this endpoint calls paid AI + image APIs on a
  // cache miss, so it's a real cost target without a limit. ────────────
  const ip = getClientIp(req);
  const rlStore = getStore("rate-limits");
  const rlKey = `trend-article:${ip}`;
  const rlData = await rlStore.get(rlKey, { type: "json" }).catch(() => null);
  const now = Date.now();
  if (rlData && rlData.count >= RATE_LIMIT_MAX && now - rlData.windowStart < RATE_LIMIT_WINDOW_MS) {
    await logSecurityEvent("rate_limit_blocked", "get-trend-article", ip);
    return new Response(JSON.stringify({ error: "Too many requests. Please try again later." }), { status: 429, headers });
  }
  const newRlData = rlData && now - rlData.windowStart < RATE_LIMIT_WINDOW_MS
    ? { count: rlData.count + 1, windowStart: rlData.windowStart }
    : { count: 1, windowStart: now };
  await rlStore.setJSON(rlKey, newRlData);

  // ── Look up the REAL trend from stored issue data — never trust
  // client-supplied title/summary text directly. Without this, anyone
  // could pass arbitrary unique strings to force fresh (costly) AI calls
  // on every request, bypassing the cache entirely. ────────────────────
  const nlStore = getStore("newsletters");
  const nl = await nlStore.get(issueKey, { type: "json" }).catch(() => null);
  const trend = nl?.trends?.[trendIndex];
  if (!trend) {
    return new Response(JSON.stringify({ error: "Trend not found for that issue" }), { status: 404, headers });
  }

  const title = trend.title;
  const summary = trend.summary;
  const month = nl.month;
  const year = nl.year;

  // Check cache first
  const cacheStore = getStore("trend-articles");
  const cacheKey = `${issueKey}-${trendIndex}`;

  try {
    const cached = await cacheStore.get(cacheKey, { type: "json" });
    if (cached) {
      return new Response(JSON.stringify({ article: cached.article, image: cached.image || null, cached: true }), { headers });
    }
  } catch {}

  const prompt = `You are Fern, writing an in-depth trend article for "The Cultured Table," your premium monthly newsletter.

Write a compelling, informative article (400-600 words) about this food trend for ${month} ${year}:

TREND: ${title}
CONTEXT: ${summary}

Structure the article as flowing prose with 3-4 natural paragraphs. No headers, no bullet points — just great editorial writing.

Cover:
- What's driving this trend right now (cultural, scientific, or culinary forces)
- Real-world examples: specific dishes, restaurants, products, or people leading the movement
- Practical angle: how a home cook can explore or benefit from this trend
- Forward look: where this trend is heading

Voice: this is you, Fern — warm, knowledgeable, slightly opinionated, like a trusted food editor who actually cooks. Be specific and vivid.

Return ONLY the article text, no title, no byline, no markdown.`;

  const [rawArticle, image] = await Promise.all([
    generateText(prompt, 1000),
    fetchPexelsImage(`${title} food`),
  ]);

  const article = rawArticle.trim();

  await cacheStore.setJSON(cacheKey, { article, image, title, generated_at: new Date().toISOString() });

  return new Response(JSON.stringify({ article, image, cached: false }), { headers });
};
