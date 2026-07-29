// netlify/functions/blogger-digest.js
// Monthly email to every active blogger with their own real stats (recipes
// published, saves, earnings). Reuses this newsletter's Resend setup —
// separate audience (bloggers table) from the newsletter subscriber list.
import { getStore } from "@netlify/blobs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BATCH_LIMIT = 500; // Resend + Supabase page size; raise if the roster grows past this

async function fetchActiveBloggers() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/bloggers?select=*&status=eq.active&limit=${BATCH_LIMIT}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) throw new Error(`Supabase bloggers query failed: ${res.status}`);
  return res.json();
}

function buildEmailHTML(b) {
  const firstName = (b.name || "").split(" ")[0] || "there";
  return `<div style="font-family:Georgia,serif;max-width:480px;margin:0 auto;padding:32px 24px;background:#fffdf7;">
    <p style="font-size:12px;letter-spacing:.15em;text-transform:uppercase;color:#c8922a;margin:0 0 6px">Blogger Cookbook · Monthly Stats</p>
    <p style="font-size:20px;color:#1a1a1a;margin:0 0 24px">Hey ${firstName} 👋</p>
    <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
      <tr><td style="padding:10px 0;font-size:14px;color:#555;border-bottom:1px solid #ede8dc">Recipes published</td><td style="padding:10px 0;font-size:18px;font-weight:700;text-align:right;border-bottom:1px solid #ede8dc">${b.recipes_published ?? 0}</td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#555;border-bottom:1px solid #ede8dc">Total saves</td><td style="padding:10px 0;font-size:18px;font-weight:700;text-align:right;border-bottom:1px solid #ede8dc">${b.total_saves ?? 0}</td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#555;border-bottom:1px solid #ede8dc">Total clicks</td><td style="padding:10px 0;font-size:18px;font-weight:700;text-align:right;border-bottom:1px solid #ede8dc">${b.total_clicks ?? 0}</td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#555">Total earnings</td><td style="padding:10px 0;font-size:18px;font-weight:700;text-align:right">$${Number(b.total_earnings || 0).toFixed(2)}</td></tr>
    </table>
    ${b.top_recipe_title ? `<p style="font-size:14px;color:#555;margin:0 0 24px">Your top recipe this period: <strong>${b.top_recipe_title}</strong> (${b.top_recipe_saves ?? 0} saves)</p>` : ""}
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
  const key = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || "newsletter@clickpickandcook.com";
  if (!key) return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), { status: 500, headers });

  try {
    const bloggers = await fetchActiveBloggers();
    let sent = 0, failed = 0;

    for (const b of bloggers) {
      if (!b.email) { failed++; continue; }
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          from: `Blogger Cookbook <${FROM}>`,
          to: b.email,
          subject: `Your Blogger Cookbook stats — ${b.recipes_published ?? 0} recipes, ${b.total_saves ?? 0} saves`,
          html: buildEmailHTML(b),
        }),
      }).catch(() => null);
      if (res && res.ok) sent++; else failed++;
    }

    // Track the run so the admin panel / metrics digest can report on it later
    const runStore = getStore("blogger-digest-runs");
    await runStore.setJSON(new Date().toISOString().slice(0, 10), { sent, failed, total: bloggers.length });

    return new Response(JSON.stringify({ success: true, sent, failed, total: bloggers.length }), { headers });
  } catch (e) {
    console.error("[blogger-digest] failed:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
  }
};

export const config = { schedule: "0 9 1 * *" }; // 1st of every month, 9am UTC
