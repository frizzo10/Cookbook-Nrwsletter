// netlify/functions/metrics-digest.js
// Weekly internal digest — signups, active users, newsletter growth, content
// queue backlog. Sent to ADMIN_ALERT_EMAIL so the pro forma stays honestly
// tracked against reality instead of only checked manually.
import { getStore } from "@netlify/blobs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function daysAgoISO(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

// Supabase Auth admin API paginates at up to 1000/page. Fern's user base is
// small enough right now that a handful of pages covers everything; if this
// ever silently under-counts, raise the page cap below.
async function fetchAllFernUsers() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  let all = [];
  let page = 1;
  const perPage = 1000;
  const maxPages = 10; // safety cap — 10k users before this needs revisiting
  while (page <= maxPages) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${perPage}`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!res.ok) {
      console.error("[metrics-digest] auth users fetch failed:", res.status);
      break;
    }
    const data = await res.json();
    const users = data.users || [];
    all = all.concat(users);
    if (users.length < perPage) break;
    page++;
  }
  return all;
}

async function fetchActiveUserDataCount(sinceISO) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_data?select=user_id&updated_at=gte.${encodeURIComponent(sinceISO)}`,
      {
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          Prefer: "count=exact",
          Range: "0-0",
        },
      }
    );
    const contentRange = res.headers.get("content-range"); // e.g. "0-0/143"
    if (contentRange) {
      const total = contentRange.split("/")[1];
      return total ? parseInt(total, 10) : null;
    }
    return null;
  } catch (e) {
    console.error("[metrics-digest] active user_data count failed:", e.message);
    return null;
  }
}

function statRow(label, value) {
  return `<tr>
    <td style="padding:10px 0;font-size:14px;color:#555;border-bottom:1px solid #ede8dc">${label}</td>
    <td style="padding:10px 0;font-size:18px;font-weight:700;color:#1a1a1a;text-align:right;border-bottom:1px solid #ede8dc">${value}</td>
  </tr>`;
}

export default async (req) => {
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    if (body.secret !== process.env.CRON_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const sevenDaysAgo = daysAgoISO(7);

    // Fern signups (all-time total + new this week)
    const allUsers = await fetchAllFernUsers();
    const totalSignups = allUsers ? allUsers.length : null;
    const newSignupsThisWeek = allUsers
      ? allUsers.filter(u => u.created_at && u.created_at >= sevenDaysAgo).length
      : null;

    // Active Fern users (user_data row touched in last 7 days)
    const activeThisWeek = await fetchActiveUserDataCount(sevenDaysAgo);

    // Newsletter subscriber stats
    const subStore = getStore("subscribers");
    const subList = (await subStore.get("list", { type: "json" }).catch(() => [])) || [];
    const activeSubs = subList.filter(s => !s.unsubscribed);
    const newSubsThisWeek = subList.filter(s => s.subscribed_at && s.subscribed_at >= sevenDaysAgo).length;

    // Content queue backlog
    const cqStore = getStore("content-queue");
    const cqItems = (await cqStore.get("items", { type: "json" }).catch(() => [])) || [];
    const pendingContent = cqItems.filter(i => i.status === "pending").length;

    const html = `<div style="font-family:Georgia,serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fffdf7;">
      <p style="font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#c8a96e;margin:0 0 6px">Weekly Metrics Digest</p>
      <p style="font-size:13px;color:#999;margin:0 0 24px">${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
      <table style="width:100%;border-collapse:collapse">
        ${statRow("Fern signups (total)", totalSignups ?? "—")}
        ${statRow("New Fern signups (7 days)", newSignupsThisWeek ?? "—")}
        ${statRow("Active Fern users (7 days)", activeThisWeek ?? "—")}
        ${statRow("Newsletter subscribers (active)", activeSubs.length)}
        ${statRow("New subscribers (7 days)", newSubsThisWeek)}
        ${statRow("Content queue — pending review", pendingContent)}
      </table>
      <p style="margin:24px 0 0;font-size:12px;color:#aaa;line-height:1.6">Pulled automatically from Fern's Supabase and this newsletter's subscriber/content-queue stores. "—" means that source wasn't reachable this run — check System Health in the admin panel.</p>
    </div>`;

    const key = process.env.RESEND_API_KEY;
    const to = process.env.ADMIN_ALERT_EMAIL;
    if (key && to) {
      const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          from: `Fern Metrics <${FROM}>`,
          to,
          subject: `Weekly metrics — ${totalSignups ?? "?"} signups, ${activeSubs.length} subscribers`,
          html,
        }),
      });
    }

    return new Response(
      JSON.stringify({ success: true, totalSignups, newSignupsThisWeek, activeThisWeek, subscribers: activeSubs.length, newSubsThisWeek, pendingContent }),
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("[metrics-digest] failed:", e.message);
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
};

export const config = { schedule: "0 8 * * 1" }; // Mondays 8am UTC
