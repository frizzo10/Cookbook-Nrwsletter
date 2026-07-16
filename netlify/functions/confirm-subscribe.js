// netlify/functions/confirm-subscribe.js
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const url = new URL(req.url);
  const email = decodeURIComponent(url.searchParams.get("email") || "");
  const token = url.searchParams.get("token") || "";

  const store = getStore("subscribers");
  const list = await store.get("list", { type: "json" }).catch(() => []);

  const sub = (list || []).find((s) => s.email === email && s.confirmToken === token);
  if (!sub) {
    return new Response(html("Error", "Invalid or expired confirmation link."), {
      headers: { "Content-Type": "text/html" },
    });
  }

  sub.confirmed = true;
  sub.confirmed_at = new Date().toISOString();
  await store.setJSON("list", list);

  return new Response(
    html("You're In!", `You're now subscribed to The Cultured Table. Your first personalized issue arrives on the 1st. <a href="https://cookbookai1.netlify.app" style="color:#c8a96e">Explore the latest issue →</a>`),
    { headers: { "Content-Type": "text/html" } }
  );
};

function html(title, msg) {
  return `<!DOCTYPE html><html><body style="font-family:Georgia,serif;max-width:500px;margin:80px auto;text-align:center;color:#1a1a1a;">
    <h2 style="font-weight:400">${title}</h2><p style="color:#555;line-height:1.8">${msg}</p>
  </body></html>`;
}
