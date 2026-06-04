// netlify/functions/unsubscribe.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const email = decodeURIComponent(url.searchParams.get("email") || "");
  const token = url.searchParams.get("token") || "";

  const store = getStore("subscribers");
  const list = await store.get("list", { type: "json" }).catch(() => []);

  const sub = list.find((s) => s.email === email && s.token === token);
  if (!sub) {
    return new Response(html("Error", "Invalid unsubscribe link."), {
      headers: { "Content-Type": "text/html" },
    });
  }

  sub.unsubscribed = true;
  sub.unsubscribed_at = new Date().toISOString();
  await store.setJSON("list", list);

  return new Response(html("Unsubscribed", `You've been removed from The Cultured Table. We'll miss you! <a href="https://cookbookai1.netlify.app" style="color:#c8a96e">Visit our site</a>`), {
    headers: { "Content-Type": "text/html" },
  });
};

function html(title, msg) {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:500px;margin:80px auto;text-align:center;color:#1a1a1a;">
    <h2 style="font-weight:400">${title}</h2><p style="color:#555;line-height:1.8">${msg}</p>
  </body></html>`;
}
