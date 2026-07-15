// netlify/functions/preview-email.js
// View the exact HTML that gets emailed, right in your browser — no email
// sent, no waiting. Note: browsers render CSS more permissively than most
// email clients (Gmail/Outlook strip a lot), so this is a fast sanity check,
// not a substitute for an actual test send. Use send-newsletter's testEmail
// option for a true rendering check.
import { getStore } from "@netlify/blobs";

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
        <a href="#" style="color:#c8a96e;text-decoration:none">Unsubscribe</a> ·
        <a href="https://cookbookai1.netlify.app" style="color:#c8a96e;text-decoration:none">View in browser</a>
      </p>
    </div>
  </div>
</body>
</html>`;
}

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "latest";
  const name = url.searchParams.get("name") || ""; // preview with a greeting, e.g. ?name=Frank

  const store = getStore("newsletters");
  const nl = await store.get(key, { type: "json" }).catch(() => null);

  if (!nl) {
    return new Response("<h1>No newsletter found for that key.</h1>", {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  }

  const html = buildEmailHTML(nl, { name });
  return new Response(html, { headers: { "Content-Type": "text/html" } });
};
