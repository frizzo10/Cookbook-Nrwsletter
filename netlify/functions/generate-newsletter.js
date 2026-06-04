// netlify/functions/generate-newsletter.js
// Triggered by monthly cron OR manually via POST
// Uses Anthropic Claude to generate food trends + 3 recipes
// Stores result in Netlify Blobs, then triggers send

import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async (req, context) => {
  // Allow manual trigger via POST with secret
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const now = new Date();
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const year = now.getFullYear();

  console.log(`Generating newsletter for ${monthName} ${year}...`);

  // --- 1. Generate content via Claude ---
  const prompt = `You are the editor of "The Cultured Table" — a premium monthly food and diet newsletter. 
Generate a complete newsletter for ${monthName} ${year}.

Return ONLY valid JSON in this exact structure (no markdown, no backticks):
{
  "subject": "email subject line (engaging, under 60 chars)",
  "tagline": "one punchy sentence for this issue",
  "trends": [
    {
      "title": "trend name",
      "summary": "2-3 sentence description of this food/diet trend. Be specific, cite real movements.",
      "why_it_matters": "1 sentence on why readers should care"
    },
    { ... },
    { ... }
  ],
  "recipes": [
    {
      "name": "recipe name",
      "description": "2 sentence enticing description",
      "prep_time": "X mins",
      "cook_time": "X mins",
      "servings": N,
      "ingredients": ["item 1", "item 2", ...],
      "instructions": ["Step 1...", "Step 2...", ...],
      "tip": "one chef's tip"
    },
    { ... },
    { ... }
  ],
  "quote": "an inspiring food or health quote with attribution",
  "editors_note": "2-3 sentences from the editor — warm, personal, forward-looking"
}

Guidelines:
- Trends should reflect CURRENT movements (fermentation revival, protein diversity, longevity diets, etc.)
- Recipes should span different meal types (one breakfast/brunch, one lunch/dinner, one dessert or snack)
- All 3 recipes must tie to one of the trends mentioned
- Keep the whole thing fitting a beautiful 2-page printed newsletter
- Voice: warm, knowledgeable, slightly editorial — like Bon Appétit meets a nutritionist friend`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.trim();
  let newsletter;
  try {
    newsletter = JSON.parse(raw);
  } catch (e) {
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/```json|```/g, "").trim();
    newsletter = JSON.parse(cleaned);
  }

  newsletter.month = monthName;
  newsletter.year = year;
  newsletter.generated_at = now.toISOString();

  // --- 2. Store in Netlify Blobs ---
  const store = getStore("newsletters");
  const key = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  await store.setJSON(key, newsletter);
  await store.setJSON("latest", newsletter); // always keep "latest" pointer

  console.log(`Newsletter stored as key: ${key}`);

  // --- 3. Trigger send function ---
  const siteUrl = process.env.URL || "https://cookbookai1.netlify.app";
  const sendRes = await fetch(`${siteUrl}/.netlify/functions/send-newsletter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret: process.env.CRON_SECRET, key }),
  });

  const sendResult = await sendRes.json().catch(() => ({}));
  console.log("Send result:", sendResult);

  return new Response(
    JSON.stringify({ success: true, month: `${monthName} ${year}`, sent: sendResult }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = { schedule: "0 9 1 * *" };
