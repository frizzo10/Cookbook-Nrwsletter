// netlify/functions/blogger-industry-digest.js
// Monthly "industry trends" newsletter for food bloggers -- separate from
// blogger-digest.js (which sends each blogger their own personal stats).
// This one is about the broader industry: real headlines, real search
// trends, real network data. Same audience (bloggers table, status=active),
// same cron as both blogger-digest.js and Cultured Table's
// generate-newsletter.js (1st of month, 9am UTC).
//
// Every section here is built from a real, verifiable source -- nothing
// is AI-written or invented:
//   1. Industry Headlines   -- real RSS pull from Food Blogger Pro's own
//                               podcast feed (foodbloggerpro.libsyn.com/rss)
//   2. Search Trends        -- real rows from search_log (Fern's main app,
//                               same Supabase project)
//   3. Network Highlights   -- real rows from bc_recipes / bc_profiles
//                               (BloggerCookbook, same Supabase project)
//   4. Worth Your Time      -- 2 of the same real Food Blogger Pro episodes
//                               from section 1, plus a link to Blogger
//                               Cookbook's own (real, already-live)
//                               referral program
import { getStore } from "@netlify/blobs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;
const FROM = process.env.FROM_EMAIL || "newsletter@clickpickandcook.com";
const BATCH_LIMIT = 500;

async function supaGet(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) {
    console.error(`[blogger-industry-digest] Supabase query failed (${res.status}): ${path}`);
    return [];
  }
  return res.json();
}

async function fetchActiveBloggers() {
  return supaGet(`/rest/v1/bloggers?select=*&status=eq.active&limit=${BATCH_LIMIT}`);
}

// ── Section 1: real RSS pull from Food Blogger Pro's podcast feed ──────
// Lightweight regex parser -- no XML library installed in this repo, and
// podcast RSS (Libsyn-hosted, RSS 2.0) is a predictable enough format that
// a full parser would be overkill for pulling title/link/description out
// of <item> blocks.
async function fetchIndustryHeadlines(limit = 4) {
  try {
    const res = await fetch("https://foodbloggerpro.libsyn.com/rss");
    if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
    const xml = await res.text();
    const items = [];
    const itemBlocks = xml.split("<item>").slice(1, limit + 1);
    for (const block of itemBlocks) {
      const title = extractTag(block, "title");
      const link = extractTag(block, "link");
      let description = extractTag(block, "description") || extractTag(block, "itunes:summary");
      if (description) description = description.replace(/<[^>]+>/g, "").trim().slice(0, 220);
      if (title && link) items.push({ title, link, description });
    }
    return items;
  } catch (e) {
    console.error("[blogger-industry-digest] Industry headlines fetch failed:", e.message);
    return []; // degrade gracefully -- a missing section shouldn't block the rest
  }
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return null;
  let val = m[1].trim();
  const cdata = val.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata) val = cdata[1].trim();
  return val;
}

// ── Section 2: real search trend data from Fern's main app ─────────────
async function fetchSearchTrends(limit = 5) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await supaGet(
    `/rest/v1/search_log?select=query&created_at=gte.${since}&feature=eq.recipe_search&limit=2000`
  );
  if (!rows.length) return [];
  const counts = {};
  for (const r of rows) {
    const q = (r.query || "").trim().toLowerCase();
    if (!q) continue;
    counts[q] = (counts[q] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([query, count]) => ({ query, count }));
}

// ── Section 3: real network data from BloggerCookbook ───────────────────
async function fetchNetworkHighlights() {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [topRecipes, newBloggers] = await Promise.all([
    supaGet(`/rest/v1/bc_recipes?select=title,cuisine,saves&order=saves.desc&limit=1`),
    supaGet(`/rest/v1/bc_profiles?select=id&created_at=gte.${since}`),
  ]);
  return {
    topRecipe: topRecipes[0] || null,
    newBloggerCount: newBloggers.length,
  };
}

function buildEmailHTML({ headlines, trends, network, monthName, year }) {
  const headlineRows = headlines.length
    ? headlines.map(h => `
      <div style="padding:14px 0;border-bottom:1px solid #ede8dc">
        <a href="${h.link}" style="font-size:15px;font-weight:700;color:#1a1a1a;text-decoration:none;">${h.title}</a>
        ${h.description ? `<p style="font-size:13px;color:#666;margin:6px 0 0;line-height:1.5">${h.description}</p>` : ""}
      </div>`).join("")
    : `<p style="font-size:13px;color:#999">No new episodes this month.</p>`;

  const trendRows = trends.length
    ? `<table style="width:100%;border-collapse:collapse">` + trends.map((t, i) => `
      <tr><td style="padding:8px 0;font-size:14px;color:#555;border-bottom:1px solid #ede8dc">${i + 1}. ${t.query}</td>
      <td style="padding:8px 0;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #ede8dc;color:#c8922a">${t.count}×</td></tr>`).join("") + `</table>`
    : `<p style="font-size:13px;color:#999">Not enough search volume yet this month to report a trend.</p>`;

  const networkHTML = `
    ${network.topRecipe ? `<p style="font-size:14px;color:#555;margin:0 0 10px">🏆 Top recipe across the network: <strong>${network.topRecipe.title}</strong>${network.topRecipe.cuisine ? ` (${network.topRecipe.cuisine})` : ""} — ${network.topRecipe.saves ?? 0} saves</p>` : ""}
    <p style="font-size:14px;color:#555;margin:0">👋 ${network.newBloggerCount} new blogger${network.newBloggerCount === 1 ? "" : "s"} joined Blogger Cookbook this month</p>
  `;

  return `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fffdf7;">
    <p style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#c8922a;margin:0 0 6px">Blogger Cookbook · Industry Digest</p>
    <p style="font-size:22px;color:#1a1a1a;margin:0 0 28px">${monthName} ${year}</p>

    <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#1a1a1a;margin:0 0 4px">Industry Headlines</p>
    <p style="font-size:11px;color:#999;margin:0 0 6px">From the Food Blogger Pro Podcast</p>
    ${headlineRows}

    <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#1a1a1a;margin:28px 0 4px">What Home Cooks Searched For</p>
    <p style="font-size:11px;color:#999;margin:0 0 10px">Real search terms from Fern this month</p>
    ${trendRows}

    <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#1a1a1a;margin:28px 0 10px">Network Highlights</p>
    ${networkHTML}

    <p style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#1a1a1a;margin:28px 0 10px">Worth Your Time</p>
    <p style="font-size:14px;color:#555;margin:0 0 8px">${headlines[0] ? `<a href="${headlines[0].link}" style="color:#c8922a">${headlines[0].title} →</a>` : ""}</p>
    <p style="font-size:14px;color:#555;margin:0 0 20px">${headlines[1] ? `<a href="${headlines[1].link}" style="color:#c8922a">${headlines[1].title} →</a>` : ""}</p>
    <p style="font-size:14px;color:#555;margin:0 0 24px"><a href="https://app.bloggercookbook.com" style="color:#c8922a">Refer another blogger — 35% revenue share for 3 months →</a></p>

    <p style="font-size:13px;color:#999;margin:0">Thanks for being part of the Blogger Cookbook program.</p>
  </div>`;
}

export default async (req) => {
  const headers = { "Content-Type": "application/json" };
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
    }
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: "Supabase not configured" }), { status: 500, headers });
  }
  if (!RESEND_KEY) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500, headers });
  }

  try {
    const now = new Date();
    const monthName = now.toLocaleString("en-US", { month: "long" });
    const year = now.getFullYear();

    const [bloggers, headlines, trends, network] = await Promise.all([
      fetchActiveBloggers(),
      fetchIndustryHeadlines(),
      fetchSearchTrends(),
      fetchNetworkHighlights(),
    ]);

    const html = buildEmailHTML({ headlines, trends, network, monthName, year });
    let sent = 0, failed = 0;

    for (const b of bloggers) {
      if (!b.email) { failed++; continue; }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_KEY}` },
        body: JSON.stringify({
          from: `Blogger Cookbook <${FROM}>`,
          to: b.email,
          subject: `Food Blogging Industry Digest — ${monthName} ${year}`,
          html,
        }),
      }).catch(() => null);
      if (res && res.ok) sent++; else failed++;
    }

    const runStore = getStore("blogger-industry-digest-runs");
    await runStore.setJSON(new Date().toISOString().slice(0, 10), {
      sent, failed, total: bloggers.length,
      headlineCount: headlines.length, trendCount: trends.length,
    });

    return new Response(JSON.stringify({ success: true, sent, failed, total: bloggers.length }), { headers });
  } catch (e) {
    console.error("[blogger-industry-digest] failed:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};

export const config = { schedule: "0 9 1 * *" }; // 1st of every month, 9am UTC -- same as generate-newsletter.js and blogger-digest.js
