// netlify/functions/generate-newsletter.js
import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function generateAndStore() {
  const now = new Date();
  const monthName = now.toLocaleString("en-US", { month: "long" });
  const year = now.getFullYear();

  const prompt = `You are the editor of "The Cultured Table" — a premium monthly food and diet newsletter. 
Generate a complete newsletter for ${monthName} ${year}.

Return ONLY valid JSON in this exact structure (no markdown, no backticks):
{
  "subject": "email subject line (engaging, under 60 chars)",
  "tagline": "one punchy sentence for this issue",
  "trends": [
    {
      "title": "trend name",
      "summary": "2-3 sentence description of this food/diet trend.",
      "why_it_matters": "1 sentence on why readers should care"
    },
    { "title": "...", "summary": "...", "why_it_matters": "..." },
    { "title": "...", "summary": "...", "why_it_matters": "..." }
  ],
  "recipes": [
    {
      "name": "recipe name",
      "description": "2 sentence enticing description",
      "prep_time": "X mins",
      "cook_time": "X mins",
      "servings": 4,
      "ingredients": ["item 1", "item 2"],
      "instructions": ["Step 1", "Step 2"],
      "tip": "one chef tip"
    },
    { "name": "...", "description": "...", "prep_time": "...", "cook_time": "...", "servings": 4, "ingredients": [], "instructions": [], "tip": "..." },
    { "name": "...", "description": "...", "prep_time": "...", "cook_time": "...", "servings": 4, "ingredients": [], "instructions": [], "tip": "..." }
  ],
  "quote": "an inspiring food quote — Author Name",
  "editors_note": "2-3 warm sentences from the editor"
}

Guidelines:
- Trends: fermentation, protein diversity, longevity diets, etc.
- Recipes: one breakfast, one dinner, one dessert — all tied to a trend
- Voice: warm, editorial, like Bon Appétit meets a nutritionist`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 3000,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content[0].text.trim().replace(/```json|```/g, "").trim();
  const newsletter = JSON.parse(raw);
  newsletter.month = monthName;
  newsletter.year = year;
  newsletter.generated_at = now.toISOString();

  const store = getStore("newsletters");
  const key = `${year}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  await store.setJSON(key, newsletter);
  await store.setJSON("latest", newsletter);

  console.log(`Newsletter generated and stored: ${key}`);
}

export default async (req, context) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // Return immediately — run generation in background
  context.waitUntil(generateAndStore());

  return new Response(
    JSON.stringify({ success: true, message: "Newsletter generation started. Refresh site in 30 seconds." }),
    { headers: { "Content-Type": "application/json" } }
  );
};

export const config = { schedule: "0 9 1 * *" };
