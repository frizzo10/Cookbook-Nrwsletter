// netlify/functions/generate-deals-digest.js
// Weekly "Biggest Deals" post — scans recently-updated circular data already
// sitting in Fern's main Supabase (user_data.circular, populated by the
// app's circular-scanning feature), asks the AI to write it up as a blog
// post, and stores it for the public /deals.html page to render. No new
// accounts or scraping needed — this is Fern's own real scanned-circular
// data, aggregated across users.
import { getStore } from "@netlify/blobs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

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
    } catch (e) { console.error("[deals-digest] Groq failed:", e.message); }
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
    } catch (e) { console.error("[deals-digest] Gemini failed:", e.message); }
  }
  return "";
}

async function fetchRecentCirculars() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_data?select=circular,updated_at&updated_at=gte.${encodeURIComponent(since)}&limit=200`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!res.ok) {
      console.error("[deals-digest] Supabase fetch failed:", res.status, await res.text());
      return [];
    }
    const rows = await res.json();
    // circular is a per-user jsonb array (shape can vary by store/scan); just
    // flatten anything non-empty and let the AI make sense of it rather than
    // assuming an exact schema.
    return rows
      .map(r => r.circular)
      .filter(c => Array.isArray(c) && c.length > 0)
      .flat()
      .slice(0, 300);
  } catch (e) {
    console.error("[deals-digest] Supabase query error:", e.message);
    return [];
  }
}

async function generateAndStore() {
  const circularItems = await fetchRecentCirculars();
  if (circularItems.length === 0) {
    throw new Error("No recent circular data found in the last 14 days — nothing to write about yet.");
  }

  const prompt = `You are Fern, writing a short "Biggest Deals This Week" post for a grocery-savings audience. Below is real scanned grocery-circular data from Fern app users (raw JSON, field names may vary by store/scan — use whatever's present: item/product names, prices, discounts, store names).

DATA (sample, may be noisy):
${JSON.stringify(circularItems.slice(0, 150))}

Write a short, punchy blog post highlighting the best real deals you can identify in this data. If the data is too sparse or unclear to call out specific deals confidently, focus on general grocery-savings observations instead of inventing specifics.

Return ONLY valid JSON, no markdown fences:
{
  "title": "catchy title, e.g. 'This Week's 5 Best Grocery Deals'",
  "intro": "1-2 sentence intro in Fern's warm, knowledgeable voice",
  "deals": [
    { "item": "item name", "store": "store name or null", "note": "1 sentence on why it's a good deal" }
  ],
  "closing": "1 sentence closing line, e.g. tying back to using Fern to catch deals like these automatically"
}
Include 3-6 deals. Never fabricate a specific price or percent-off number that isn't actually present in the data — describe the deal qualitatively if exact figures aren't clearly in the source data.`;

  const raw = await callAI(prompt, 1500);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`AI response had no JSON. First 300 chars: ${raw.slice(0, 300)}`);
  let post;
  try {
    post = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse deals post JSON: ${e.message}`);
  }

  const now = new Date();
  post.generated_at = now.toISOString();
  post.week_of = now.toISOString().slice(0, 10);

  const store = getStore("deals-posts");
  await store.setJSON(post.week_of, post);
  const { blobs } = await store.list().catch(() => ({ blobs: [] }));
  const allKeys = (blobs || []).map(b => b.key).filter(k => k !== "latest" && k !== "archive_index").sort().reverse();
  await store.setJSON("archive_index", allKeys);
  await store.setJSON("latest", post);
  console.log(`[deals-digest] stored post for week ${post.week_of}, ${post.deals?.length || 0} deals`);
}

export default async (req, context) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  context.waitUntil(
    generateAndStore().catch(async (err) => {
      console.error("[deals-digest] generation FAILED:", err.message);
      try {
        const store = getStore("deals-posts");
        await store.setJSON("last_error", { message: err.message, at: new Date().toISOString() });
      } catch (e2) { console.error("Also failed to record error:", e2.message); }
    })
  );

  return new Response(
    JSON.stringify({ success: true, message: "Deals digest generation started." }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = { schedule: "0 8 * * 3" }; // Wednesdays 8am UTC
