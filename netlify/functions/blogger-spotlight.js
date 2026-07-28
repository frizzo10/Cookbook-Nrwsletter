// netlify/functions/blogger-spotlight.js
// Weekly "Blogger of the Week" feature — pulls real stats (top earner, most
// saves) from the bloggers table and has the AI write a short spotlight.
// Stored for a public page to render, same pattern as generate-deals-digest.js.
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
        body: JSON.stringify({ model: "qwen/qwen3.6-27b", reasoning_effort: "none", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      const data = await res.json();
      const text = (data.choices?.[0]?.message?.content || "").trim();
      if (res.ok && text) return text;
    } catch (e) { console.error("[blogger-spotlight] Groq failed:", e.message); }
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
    } catch (e) { console.error("[blogger-spotlight] Gemini failed:", e.message); }
  }
  return "";
}

async function fetchTopBloggers() {
  // Top earner and top-by-saves — may be the same person, dedupe below.
  const [byEarnings, bySaves] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/bloggers?select=*&status=eq.active&order=total_earnings.desc&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }).then(r => r.json()),
    fetch(`${SUPABASE_URL}/rest/v1/bloggers?select=*&status=eq.active&order=total_saves.desc&limit=1`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    }).then(r => r.json()),
  ]);
  return { topEarner: byEarnings?.[0] || null, topSaves: bySaves?.[0] || null };
}

async function generateAndStore() {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase not configured");

  const { topEarner, topSaves } = await fetchTopBloggers();
  if (!topEarner && !topSaves) throw new Error("No active bloggers found in the bloggers table yet.");

  // Feature whichever blogger leads on saves (the more "content quality"
  // signal); fall back to top earner if saves data is empty.
  const featured = (topSaves && topSaves.total_saves > 0) ? topSaves : topEarner;
  if (!featured) throw new Error("No blogger with usable stats found.");

  const prompt = `Write a short "Blogger of the Week" spotlight for Fern's Blogger Cookbook program, featuring a real blogger with these real stats:

Name: ${featured.name || featured.handle || "this blogger"}
Recipes published: ${featured.recipes_published ?? "unknown"}
Total saves: ${featured.total_saves ?? "unknown"}
Top recipe: ${featured.top_recipe_title || "unknown"} (${featured.top_recipe_saves ?? "?"} saves)
Bio: ${featured.bio || "(no bio provided)"}

Return ONLY valid JSON, no markdown: {"headline": "short catchy headline", "body": "2-3 warm, genuine paragraphs (as plain text, one string, use \\n\\n between paragraphs) celebrating this blogger and their top recipe, in Fern's voice"}
Never invent stats beyond what's given above.`;

  const raw = await callAI(prompt, 900);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`AI response had no JSON. First 200 chars: ${raw.slice(0, 200)}`);
  const spotlight = JSON.parse(jsonMatch[0]);

  spotlight.blogger = {
    name: featured.name || featured.handle,
    handle: featured.handle,
    website_url: featured.website_url,
    avatar_url: featured.avatar_url,
    recipes_published: featured.recipes_published,
    total_saves: featured.total_saves,
    top_recipe_title: featured.top_recipe_title,
    top_recipe_saves: featured.top_recipe_saves,
  };
  spotlight.week_of = new Date().toISOString().slice(0, 10);
  spotlight.generated_at = new Date().toISOString();

  const store = getStore("blogger-spotlights");
  await store.setJSON(spotlight.week_of, spotlight);
  await store.setJSON("latest", spotlight);
  console.log(`[blogger-spotlight] stored spotlight for ${spotlight.blogger.name}, week ${spotlight.week_of}`);
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
      console.error("[blogger-spotlight] FAILED:", err.message);
      try {
        const store = getStore("blogger-spotlights");
        await store.setJSON("last_error", { message: err.message, at: new Date().toISOString() });
      } catch (e2) { console.error("Also failed to record error:", e2.message); }
    })
  );

  return new Response(JSON.stringify({ success: true, message: "Blogger spotlight generation started." }), { headers: { "Content-Type": "application/json" } });
};

export const config = { schedule: "0 8 * * 5" }; // Fridays 8am UTC
