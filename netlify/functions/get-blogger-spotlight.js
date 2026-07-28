// netlify/functions/get-blogger-spotlight.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" };
  const url = new URL(req.url);
  const key = url.searchParams.get("week") || "latest";
  const store = getStore("blogger-spotlights");
  const spotlight = await store.get(key, { type: "json" }).catch(() => null);
  return new Response(JSON.stringify({ spotlight: spotlight || null }), { headers });
};
