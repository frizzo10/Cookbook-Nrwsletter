// netlify/functions/get-seo-page.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" };
  const url = new URL(req.url);
  const slug = url.searchParams.get("slug");

  const store = getStore("seo-pages");
  if (!slug) {
    const index = await store.get("index", { type: "json" }).catch(() => []);
    return new Response(JSON.stringify({ pages: index || [] }), { headers });
  }
  const page = await store.get(slug, { type: "json" }).catch(() => null);
  return new Response(JSON.stringify({ page: page || null }), { headers });
};
