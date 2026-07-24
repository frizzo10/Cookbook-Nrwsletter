// netlify/functions/content-queue-api.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });

  const store = getStore("content-queue");

  if (req.method === "GET") {
    const items = (await store.get("items", { type: "json" }).catch(() => [])) || [];
    return new Response(JSON.stringify({ items }), { headers });
  }

  if (req.method === "POST") {
    const { id, status } = await req.json().catch(() => ({}));
    if (!id || !status) {
      return new Response(JSON.stringify({ error: "id and status required" }), { status: 400, headers });
    }
    if (!["pending", "posted", "dismissed"].includes(status)) {
      return new Response(JSON.stringify({ error: "invalid status" }), { status: 400, headers });
    }
    const items = (await store.get("items", { type: "json" }).catch(() => [])) || [];
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
    items[idx].status = status;
    items[idx].updated_at = new Date().toISOString();
    await store.setJSON("items", items);
    return new Response(JSON.stringify({ success: true }), { headers });
  }

  return new Response("Method not allowed", { status: 405, headers });
};
