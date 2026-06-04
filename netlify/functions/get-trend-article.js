// netlify/functions/get-trend-article.js
// Generates a full 400-600 word article for a trend on demand
// Caches result in Netlify Blobs so it's only generated once

import Anthropic from "@anthropic-ai/sdk";
import { getStore } from "@netlify/blobs";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });

  const url = new URL(req.url);
  const title = url.searchParams.get("title") || "";
  const summary = url.searchParams.get("summary") || "";
  const month = url.searchParams.get("month") || "";
  const year = url.searchParams.get("year") || "";

  if (!title) {
    return new Response(JSON.stringify({ error: "Missing title" }), { status: 400, headers });
  }

  // Check cache first
  const store = getStore("trend-articles");
  const cacheKey = `${year}-${month}-${title.toLowerCase().replace(/[^a-z0-9]/g, "-").slice(0, 60)}`;

  try {
    const cached = await store.get(cacheKey, { type: "json" });
    if (cached) {
      return new Response(JSON.stringify({ article: cached.article, cached: true }), { headers });
    }
  } catch {}

  // Generate fresh article
  const prompt = `You are a food and wellness journalist writing for "The Cultured Table," a premium monthly newsletter.

Write a compelling, informative article (400-600 words) about this food trend for ${month} ${year}:

TREND: ${title}
CONTEXT: ${summary}

Structure the article as flowing prose with 3-4 natural paragraphs. No headers, no bullet points — just great editorial writing.

Cover:
- What's driving this trend right now (cultural, scientific, or culinary forces)
- Real-world examples: specific dishes, restaurants, products, or people leading the movement  
- Practical angle: how a home cook can explore or benefit from this trend
- Forward look: where this trend is heading

Voice: warm, knowledgeable, slightly opinionated — like a trusted food editor who actually cooks. Avoid generic health-blog language. Be specific and vivid.

Return ONLY the article text, no title, no byline, no markdown.`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1000,
    messages: [{ role: "user", content: prompt }],
  });

  const article = message.content[0].text.trim();

  // Cache it
  await store.setJSON(cacheKey, { article, title, generated_at: new Date().toISOString() });

  return new Response(JSON.stringify({ article, cached: false }), { headers });
};
