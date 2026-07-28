// netlify/functions/generate-seo-pages.js
// Auto-generates and periodically refreshes a small fixed set of comparison/
// SEO landing pages. Grounded in Fern's real, already-researched facts
// (pricing tiers, Instacart fee structure) passed directly into the prompt —
// the AI is explicitly told not to invent competitor pricing beyond what's
// given here, since a wrong number on a public page is a real liability.
import { getStore } from "@netlify/blobs";

// Real facts to ground generation — update this block if pricing changes.
const KNOWN_FACTS = `
Fern facts (real, use these exactly):
- Fern: Free tier ($0) — 1 circular scan/week per store, 1 AI recipe search/day, Coupon Wallet capped at 5 coupons, 3 AI meal plans/month.
- Fern Pro: $2.99/month — unlimited scans/searches/plans, Fridge Challenge, Leftover Magic, Budget Planner, Family Vault.
- Fern Pro Max: $6.99/month — everything in Pro, plus Alexa Skill (hands-free cooking), Dinner Party Planner, Personal Shopper.
- Fern scans any store's paper/PDF circular (patent-pending) and turns sale items directly into AI-generated recipes and a shopping list — works across any grocery store, not locked to one retailer.

Instacart facts (real, publicly known, use these and don't invent others):
- Instacart charges delivery fees (typically $3.99+ depending on order size/membership), service fees (~5% or more of order total), and marks up some item prices above in-store price.
- Instacart Express membership is a paid subscription (~$99/year or ~$9.99/month) to reduce/waive delivery fees on qualifying orders.
- Instacart is a delivery/shopping service — it does not do AI meal planning or recipe generation from sale circulars.

Do not state a specific Instacart fee percentage or dollar figure beyond what's given above — describe it qualitatively as "delivery fees, service fees, and item markups that can add up" rather than fabricating precise numbers if a more specific figure isn't in this list.`;

const TARGET_PAGES = [
  {
    slug: "instacart-alternative",
    title: "Instacart Alternative",
    angle: "Positioned for someone searching for an Instacart alternative — Fern isn't a delivery service, it's a free AI layer that turns any store's sale circular into recipes and a shopping list, with no delivery/service fees or markups on the meal-planning side.",
  },
  {
    slug: "avoid-grocery-delivery-fees",
    title: "How to Avoid Grocery Delivery Fees",
    angle: "Practical angle — real tips for cutting grocery costs (shop sales, plan meals around what's discounted, use pickup instead of delivery), with Fern positioned as the tool that makes 'plan around what's on sale' actually easy by scanning the circular automatically.",
  },
  {
    slug: "best-grocery-budgeting-app",
    title: "Best Grocery Budgeting App",
    angle: "Roundup-style angle on what actually matters in a grocery budgeting app (works across stores, turns real sales into a plan, free tier that's genuinely useful) with Fern as the featured example — not a fabricated 'best of' list naming other specific apps/rankings.",
  },
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
    } catch (e) { console.error("[seo-pages] Groq failed:", e.message); }
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
    } catch (e) { console.error("[seo-pages] Gemini failed:", e.message); }
  }
  return "";
}

async function generatePage(target) {
  const prompt = `You are writing SEO content for Fern's marketing site. Target page: "${target.title}" (slug: ${target.slug}).

Angle: ${target.angle}

${KNOWN_FACTS}

Return ONLY valid JSON, no markdown fences:
{
  "meta_title": "under 60 chars, includes the core keyword naturally",
  "meta_description": "under 155 chars, compelling, includes the core keyword",
  "h1": "page headline",
  "intro": "2-3 sentence intro paragraph",
  "sections": [
    { "heading": "section heading", "body": "2-4 sentence section content" }
  ],
  "cta_heading": "short heading for the closing call-to-action",
  "cta_body": "1-2 sentences leading into trying Fern"
}
Include 3-4 sections. Tone: helpful and factual, not salesy. Never state a specific competitor price/fee number beyond what's given in the facts above.`;

  const raw = await callAI(prompt, 1800);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in AI response for ${target.slug}. First 200 chars: ${raw.slice(0, 200)}`);
  const page = JSON.parse(jsonMatch[0]);
  page.slug = target.slug;
  page.generated_at = new Date().toISOString();
  return page;
}

export default async (req, context) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  context.waitUntil((async () => {
    const store = getStore("seo-pages");
    const results = [];
    for (const target of TARGET_PAGES) {
      try {
        const page = await generatePage(target);
        await store.setJSON(target.slug, page);
        results.push({ slug: target.slug, ok: true });
      } catch (e) {
        console.error(`[seo-pages] failed for ${target.slug}:`, e.message);
        results.push({ slug: target.slug, ok: false, error: e.message });
      }
    }
    await store.setJSON("index", TARGET_PAGES.map(t => ({ slug: t.slug, title: t.title })));
    console.log("[seo-pages] refresh complete:", JSON.stringify(results));
  })());

  return new Response(JSON.stringify({ success: true, message: "SEO page generation started for " + TARGET_PAGES.length + " pages." }), { headers: { "Content-Type": "application/json" } });
};

export const config = { schedule: "0 7 1 * *" }; // 1st of every month, 7am UTC
