// netlify/functions/list-issues.js
// Public, no auth required — lists past issue keys (YYYY-MM) so visitors
// can browse the archive. Mirrors admin-api.js's "issues" action, but that
// one requires an admin token; this is the public-facing equivalent.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };

  const store = getStore("newsletters");
  const { keys } = await store.list().catch(() => ({ keys: [] }));
  const issueKeys = (keys || [])
    .map(k => k.name)
    .filter(k => k !== "latest" && /^\d{4}-\d{2}$/.test(k))
    .sort()
    .reverse();

  return new Response(JSON.stringify({ issues: issueKeys }), { headers });
};
