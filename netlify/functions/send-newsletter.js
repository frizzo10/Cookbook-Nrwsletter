// netlify/functions/send-newsletter.js
import { getStore } from "@netlify/blobs";

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
  console.error("[send-newsletter] Qwen failed (" + (primary.error || "empty") + "), falling back to Gemini");
  const fallback = await callGeminiFallback(prompt, maxTokens);
  if (fallback.ok && fallback.text.trim()) return fallback.text;
  throw new Error(`Both Qwen and Gemini failed. Qwen: ${primary.error || "empty response"}. Gemini: ${fallback.error || "empty response"}.`);
}

async function personalize(nl, sub) {
  const { diet, skill, allergies } = sub.prefs || {};
  const firstName = (sub.name || "").split(" ")[0] || "there";

  // If no meaningful prefs, return base newsletter as-is
  const isDefault = (!diet || diet === "omnivore") && (!skill || skill === "intermediate") && (!allergies || allergies.length === 0);
  if (isDefault) return nl;

  const allergyNote = allergies && allergies.length > 0 ? `Allergies/intolerances to avoid: ${allergies.join(", ")}.` : "";

  const prompt = `You are personalizing a food newsletter for a specific reader.

Reader profile:
- Name: ${firstName}
- Diet: ${diet}
- Cooking skill: ${skill}
- ${allergyNote}

BASE NEWSLETTER (JSON):
${JSON.stringify({ trends: nl.trends, recipes: nl.recipes, editors_note: nl.editors_note }, null, 2)}

Your job: rewrite the newsletter content to match this reader's profile.

Rules:
- Rewrite all 3 recipes to fit their diet (${diet}) and skill level (${skill})${allergyNote ? ` with no ${allergies.join(", ")}` : ""}
- Keep the same recipe structure (name, description, prep_time, cook_time, servings, ingredients, instructions, tip)
- Adjust the trends summaries to emphasize angles relevant to ${diet} eating
- Rewrite editors_note to address ${firstName} personally and reference their ${diet} lifestyle
- Keep the same JSON structure — return ONLY valid JSON, no markdown

Return JSON with keys: trends (array of 3), recipes (array of 3), editors_note (string)`;

  const raw = await generateText(prompt, 6000);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`Personalization AI response contained no JSON object. Raw (first 300 chars): ${raw.slice(0, 300)}`);
  }
  let personalized;
  try {
    personalized = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse personalized JSON (${e.message}). Raw length was ${raw.length} chars.`);
  }

  return {
    ...nl,
    trends: personalized.trends || nl.trends,
    recipes: personalized.recipes || nl.recipes,
    editors_note: personalized.editors_note || nl.editors_note,
  };
}

function buildEmailHTML(nl, sub) {
  const firstName = (sub.name || "").split(" ")[0] || "";
  const greeting = firstName ? `for ${firstName}` : "";

  const SITE_URL = process.env.URL || "https://cookbookai1.netlify.app";
  const monthNumbers = { January:1, February:2, March:3, April:4, May:5, June:6, July:7, August:8, September:9, October:10, November:11, December:12 };
  const issueKey = nl.year && monthNumbers[nl.month]
    ? `${nl.year}-${String(monthNumbers[nl.month]).padStart(2, "0")}`
    : null;
  const recipeLink = (i) => issueKey ? `${SITE_URL}/?issue=${issueKey}&save=${i}` : SITE_URL;

  const heroImgHTML = nl.hero_image
    ? `<img src="${nl.hero_image.url}" alt="The Cultured Table ${nl.month} ${nl.year}" style="width:100%;max-height:300px;object-fit:cover;display:block;">`
    : '';

  const recipesHTML = nl.recipes.map((r, i) => `
    <div style="margin-bottom:32px;border-left:3px solid #c8a96e;padding-left:20px;">
      ${r.image ? `<a href="${recipeLink(i)}" style="text-decoration:none"><img src="${r.image.url}" alt="${r.name}" style="width:100%;height:180px;object-fit:cover;display:block;margin-bottom:14px;margin-left:-20px;width:calc(100% + 20px);"></a>` : ''}
      <h3 style="font-family:'Georgia',serif;font-size:20px;color:#1a1a1a;margin:0 0 6px"><a href="${recipeLink(i)}" style="color:#1a1a1a;text-decoration:none">${r.name}</a></h3>
      <p style="font-size:13px;color:#888;margin:0 0 10px">⏱ Prep: ${r.prep_time} · Cook: ${r.cook_time} · Serves ${r.servings}</p>
      <p style="font-size:15px;color:#444;line-height:1.6;margin:0 0 14px">${r.description}</p>
      <p style="font-size:13px;font-weight:700;color:#1a1a1a;margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em">Ingredients</p>
      <ul style="font-size:14px;color:#555;padding-left:18px;margin:0 0 14px;line-height:1.8">
        ${r.ingredients.map((i) => `<li>${i}</li>`).join("")}
      </ul>
      <p style="font-size:13px;font-weight:700;color:#1a1a1a;margin:0 0 6px;text-transform:uppercase;letter-spacing:.05em">Instructions</p>
      <ol style="font-size:14px;color:#555;padding-left:18px;margin:0 0 12px;line-height:1.8">
        ${r.instructions.map((s) => `<li style="margin-bottom:6px">${s}</li>`).join("")}
      </ol>
      <p style="font-size:13px;color:#c8a96e;font-style:italic;margin:0 0 16px">💡 ${r.tip}</p>
      <a href="${recipeLink(i)}" style="display:inline-block;background:#1C3A1A;color:#F0E0B0;padding:.55rem 1.2rem;border-radius:8px;text-decoration:none;font-family:Georgia,serif;font-weight:700;font-size:14px">🌿 Save to My Fern Cookbook</a>
    </div>`).join("");

  const trendsHTML = nl.trends.map((t) => `
    <div style="margin-bottom:24px;">
      <h3 style="font-family:'Georgia',serif;font-size:18px;color:#1a1a1a;margin:0 0 8px">↗ ${t.title}</h3>
      <p style="font-size:15px;color:#444;line-height:1.7;margin:0 0 8px">${t.summary}</p>
      <p style="font-size:13px;color:#888;font-style:italic;margin:0"><strong>Why it matters:</strong> ${t.why_it_matters}</p>
    </div>`).join("");

  const qParts = (nl.quote || "").split(" — ");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f0e8;font-family:Georgia,serif;">
  <div style="max-width:620px;margin:0 auto;background:#fffdf7;">
    <div style="background:#1a1a1a;padding:40px 40px 30px;text-align:center;">
      ${heroImgHTML}
      ${greeting ? `<p style="font-family:'Courier New',monospace;font-size:11px;color:#a89070;letter-spacing:.15em;text-transform:uppercase;margin:0 0 6px">Personalized ${greeting}</p>` : ""}
      <p style="font-family:'Courier New',monospace;font-size:11px;color:#c8a96e;letter-spacing:.25em;text-transform:uppercase;margin:0 0 12px">Monthly Issue · ${nl.month} ${nl.year}</p>
      <h1 style="font-family:Georgia,serif;font-size:36px;color:#fffdf7;font-weight:400;margin:0 0 10px">The Cultured Table</h1>
      <p style="font-size:14px;color:#999;font-style:italic;margin:0">${nl.tagline}</p>
    </div>
    <div style="padding:32px 40px 24px;border-bottom:1px solid #ede8dc;">
      <p style="font-size:13px;color:#c8a96e;letter-spacing:.15em;text-transform:uppercase;margin:0 0 10px">A Note from Fern</p>
      <p style="font-size:15px;color:#444;line-height:1.8;font-style:italic;margin:0">${nl.editors_note}</p>
    </div>
    <div style="padding:32px 40px;border-bottom:1px solid #ede8dc;">
      <p style="font-size:13px;color:#c8a96e;letter-spacing:.15em;text-transform:uppercase;margin:0 0 24px">This Month's Trends</p>
      ${trendsHTML}
    </div>
    <div style="padding:32px 40px;border-bottom:1px solid #ede8dc;">
      <p style="font-size:13px;color:#c8a96e;letter-spacing:.15em;text-transform:uppercase;margin:0 0 24px">Recipes This Issue</p>
      ${recipesHTML}
    </div>
    <div style="padding:28px 40px;background:#f5f0e8;text-align:center;border-bottom:1px solid #ede8dc;">
      <p style="font-size:18px;color:#1a1a1a;font-style:italic;line-height:1.7;margin:0 0 10px">"${qParts[0]}"</p>
      <p style="font-size:13px;color:#888;margin:0">— ${qParts[1] || "Unknown"}</p>
    </div>
    <div style="padding:24px 40px;text-align:center;">
      <p style="font-size:12px;color:#aaa;margin:0 0 8px">You're receiving this because you subscribed to The Cultured Table.</p>
      <p style="font-size:12px;color:#aaa;margin:0">
        <a href="{{unsubscribe_url}}" style="color:#c8a96e;text-decoration:none">Unsubscribe</a> · 
        <a href="https://cookbookai1.netlify.app" style="color:#c8a96e;text-decoration:none">View in browser</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const body = await req.json().catch(() => ({}));
  if (body.secret !== process.env.CRON_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const store = getStore("newsletters");
  const key = body.key || "latest";
  const nl = await store.get(key, { type: "json" });
  if (!nl) return new Response(JSON.stringify({ error: "Newsletter not found" }), { status: 404 });

  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";

  // ── Test send: exactly one address, no subscriber list touched ──────
  if (body.testEmail) {
    const sub = { email: body.testEmail, name: body.testName || "", prefs: body.testPrefs || {} };
    try {
      const personalNl = await personalize(nl, sub);
      const html = buildEmailHTML(personalNl, sub).replace(
        "{{unsubscribe_url}}",
        "#test-send-no-real-unsubscribe-link"
      );
      const firstName = (sub.name || "").split(" ")[0];
      const subjectPrefix = firstName ? `${firstName}, ` : "";

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: `The Cultured Table <${FROM}>`,
          to: body.testEmail,
          subject: `[TEST] ${subjectPrefix}${nl.subject} · ${nl.month} ${nl.year}`,
          html,
        }),
      });
      const ok = res.ok;
      return new Response(JSON.stringify({ sent: ok, to: body.testEmail }), {
        status: ok ? 200 : 502,
        headers: { "Content-Type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
  }

  const subStore = getStore("subscribers");

  const subList = await subStore.get("list", { type: "json" }).catch(() => []);
  if (!subList || subList.length === 0) {
    return new Response(JSON.stringify({ skipped: true, reason: "No subscribers yet" }));
  }

  let sent = 0, failed = 0;

  for (const sub of subList) {
    if (!sub.email || sub.unsubscribed || !sub.confirmed) continue;

    try {
      // Personalize content for this subscriber
      const personalNl = await personalize(nl, sub);

      const html = buildEmailHTML(personalNl, sub).replace(
        "{{unsubscribe_url}}",
        `https://cookbookai1.netlify.app/.netlify/functions/unsubscribe?email=${encodeURIComponent(sub.email)}&token=${sub.token}`
      );

      const firstName = (sub.name || "").split(" ")[0];
      const subjectPrefix = firstName ? `${firstName}, ` : "";

      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_KEY}`,
        },
        body: JSON.stringify({
          from: `The Cultured Table <${FROM}>`,
          to: sub.email,
          subject: `${subjectPrefix}${nl.subject} · ${nl.month} ${nl.year}`,
          html,
        }),
      });

      if (res.ok) sent++;
      else failed++;
    } catch (e) {
      console.error(`Failed for ${sub.email}:`, e.message);
      failed++;
    }
  }

  return new Response(JSON.stringify({ sent, failed, total: subList.length }), {
    headers: { "Content-Type": "application/json" },
  });
};
