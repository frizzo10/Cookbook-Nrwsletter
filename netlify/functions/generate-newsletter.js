// netlify/functions/generate-newsletter.js
import { getStore } from "@netlify/blobs";

// ── AI: Groq (Qwen) primary, Gemini fallback ─────────────────────────
// Matches the model used across the rest of the Fern ecosystem (Fern AI's
// ai.js and Alexa skill): qwen/qwen3.6-27b on Groq with reasoning_effort:
// 'none' (required — without it, thinking-mode output can leak into the
// response). Falls back to Gemini if Groq fails or returns empty, since
// Gemini runs on separate infrastructure.
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
  console.error("[generate-newsletter] Qwen failed (" + (primary.error || "empty") + "), falling back to Gemini");
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
    return { url: best.src.large, thumb: best.src.medium, photographer: best.photographer, photographer_url: best.photographer_url };
  } catch (e) {
    console.error("Pexels error:", e.message);
    return null;
  }
}

async function generateAndStore() {
  const now = new Date();
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const year = now.getFullYear();
  const monthNum = now.getMonth() + 1; // 1-12

  // Northern hemisphere seasons (readership is US-based per the app's audience)
  const seasonMap = {
    12: "winter", 1: "winter", 2: "winter",
    3: "spring", 4: "spring", 5: "spring",
    6: "summer", 7: "summer", 8: "summer",
    9: "fall", 10: "fall", 11: "fall"
  };
  const season = seasonMap[monthNum];
  const seasonalProduceHint = {
    winter: "citrus, root vegetables, winter squash, braises, warming spices, hearty stews",
    spring: "asparagus, peas, spring onions, strawberries, artichokes, light and fresh preparations",
    summer: "tomatoes, corn, stone fruit, berries, zucchini, grilling, no-cook and chilled dishes",
    fall: "apples, pumpkin, squash, mushrooms, root vegetables, roasting, cozy comfort food"
  }[season];

  const prompt = `You are the editor of "The Cultured Table" — a premium monthly food and diet newsletter.
Generate a complete newsletter for ${monthName} ${year}.

SEASONAL CONTEXT — this issue must feel like it belongs to this exact moment in the year:
- Current season: ${season} (Northern Hemisphere)
- Produce and themes actually in season right now: ${seasonalProduceHint}
- Trends and recipes should reflect what's genuinely good, fresh, or culturally relevant in ${monthName} — not generic content that could run in any month. Reference the season naturally (ingredients, weather-appropriate cooking methods, relevant holidays or cultural moments if any fall in ${monthName}).
- Avoid suggesting out-of-season produce (e.g. no fresh stone fruit in winter, no heavy braises in peak summer) unless intentionally framed as a pantry/frozen/preserved angle.

Return ONLY valid JSON in this exact structure (no markdown, no backticks):
{
  "subject": "email subject line (engaging, under 60 chars)",
  "tagline": "one punchy sentence for this issue",
  "hero_image_query": "3-4 word Pexels search for a beautiful hero food image (e.g. 'fresh farmers market vegetables')",
  "trends": [
    {
      "title": "trend name",
      "image_query": "3-4 word Pexels search for this trend (e.g. 'fermented foods jars')",
      "summary": "2-3 sentence description of this food/diet trend.",
      "why_it_matters": "1 sentence on why readers should care"
    },
    { "title": "...", "image_query": "...", "summary": "...", "why_it_matters": "..." },
    { "title": "...", "image_query": "...", "summary": "...", "why_it_matters": "..." }
  ],
  "recipes": [
    {
      "name": "recipe name",
      "image_query": "3-4 word Pexels search for this dish (e.g. 'avocado toast breakfast')",
      "description": "2 sentence enticing description",
      "prep_time": "X mins",
      "cook_time": "X mins",
      "servings": 4,
      "ingredients": ["item 1", "item 2"],
      "instructions": ["Step 1", "Step 2"],
      "tip": "one chef tip"
    },
    { "name": "...", "image_query": "...", "description": "...", "prep_time": "...", "cook_time": "...", "servings": 4, "ingredients": [], "instructions": [], "tip": "..." },
    { "name": "...", "image_query": "...", "description": "...", "prep_time": "...", "cook_time": "...", "servings": 4, "ingredients": [], "instructions": [], "tip": "..." }
  ],
  "quote": "an inspiring food quote — Author Name",
  "editors_note": "2-3 warm sentences from the editor"
}

Guidelines:
- Trends should feel current to ${season} specifically — not generic year-round content (e.g. lean into what's actually being cooked/discussed in ${monthName}: seasonal produce peaks, weather-driven cooking styles, any relevant holidays or cultural food moments)
- Recipes: one breakfast, one dinner, one dessert — all tied to a trend, and all using ingredients realistically in season in ${monthName}
- image_query fields should be specific and visual (food/ingredient focused)
- Voice: warm, editorial, like Bon Appétit meets a nutritionist`;

  const raw = await generateText(prompt, 6000);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`AI response contained no JSON object. Raw response (first 300 chars): ${raw.slice(0, 300)}`);
  }
  let newsletter;
  try {
    newsletter = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse newsletter JSON (${e.message}). This usually means the response was truncated — raw length was ${raw.length} chars. Last 200 chars: ${raw.slice(-200)}`);
  }
  newsletter.month = monthName;
  newsletter.year = year;
  newsletter.generated_at = now.toISOString();

  // Fetch 7 images in parallel: 1 hero + 3 trends + 3 recipes
  console.log("Fetching Pexels images...");
  const [heroImg, ...rest] = await Promise.all([
    fetchPexelsImage(newsletter.hero_image_query || `${season} ${monthName} food seasonal`),
    ...newsletter.trends.map(t => fetchPexelsImage(t.image_query || t.title)),
    ...newsletter.recipes.map(r => fetchPexelsImage(r.image_query || r.name)),
  ]);

  const trendImgs = rest.slice(0, 3);
  const recipeImgs = rest.slice(3);

  newsletter.hero_image = heroImg;
  newsletter.trends = newsletter.trends.map((t, i) => ({ ...t, image: trendImgs[i] || null }));
  newsletter.recipes = newsletter.recipes.map((r, i) => ({ ...r, image: recipeImgs[i] || null }));

  console.log(`Images: hero=${!!heroImg}, trends=${trendImgs.filter(Boolean).length}/3, recipes=${recipeImgs.filter(Boolean).length}/3`);

  const store = getStore("newsletters");
  const key = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  await store.setJSON(key, newsletter);
  await store.setJSON("latest", newsletter);
  console.log(`Newsletter stored: ${key}`);
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
      console.error("Newsletter generation FAILED:", err.message, err.stack);
      // Record the failure so it's visible in the admin panel instead of
      // silently vanishing — this is exactly the class of bug that let a
      // retired model ID go unnoticed for a month.
      try {
        const store = getStore("newsletters");
        await store.setJSON("last_error", {
          message: err.message,
          at: new Date().toISOString(),
        });
      } catch (e2) { console.error("Also failed to record error:", e2.message); }
    })
  );

  return new Response(
    JSON.stringify({ success: true, message: "Newsletter generation started. Refresh site in 30 seconds." }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = { schedule: "0 9 1 * *" };
