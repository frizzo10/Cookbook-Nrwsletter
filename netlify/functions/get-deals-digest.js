// netlify/functions/get-deals-digest.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=300" };
  const url = new URL(req.url);
  const key = url.searchParams.get("week") || "latest";

  const store = getStore("deals-posts");
  const post = await store.get(key, { type: "json" }).catch(() => null);
  const archive = key === "latest" ? await store.get("archive_index", { type: "json" }).catch(() => []) : null;

  return new Response(JSON.stringify({ post: post || null, archive: archive || undefined }), { headers });
};
