// netlify/functions/get-newsletter.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const key = url.searchParams.get("key") || "latest";

  const store = getStore("newsletters");
  const nl = await store.get(key, { type: "json" }).catch(() => null);

  if (!nl) {
    return new Response(JSON.stringify({ error: "No newsletter found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" },
    });
  }

  return new Response(JSON.stringify(nl), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
};
