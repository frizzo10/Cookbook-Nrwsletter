// netlify/functions/subscribe.js
import { getStore } from "@netlify/blobs";
import crypto from "crypto";

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const body = await req.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: "Invalid email" }), { status: 400, headers });
  }

  const store = getStore("subscribers");
  const existing = await store.get("list", { type: "json" }).catch(() => []);
  const list = existing || [];

  if (list.find((s) => s.email === email && !s.unsubscribed)) {
    return new Response(JSON.stringify({ message: "Already subscribed!" }), { headers });
  }

  const token = crypto.randomBytes(16).toString("hex");
  list.push({ email, token, subscribed_at: new Date().toISOString(), unsubscribed: false });
  await store.setJSON("list", list);

  // Send welcome email via Resend
  const RESEND_KEY = process.env.RESEND_API_KEY;
  const FROM = process.env.FROM_EMAIL || "newsletter@cookbookai1.netlify.app";

  if (RESEND_KEY) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_KEY}`,
      },
      body: JSON.stringify({
        from: `The Cultured Table <${FROM}>`,
        to: email,
        subject: "Welcome to The Cultured Table 🍽️",
        html: `<div style="font-family:Georgia,serif;max-width:500px;margin:0 auto;padding:40px;background:#fffdf7;">
          <h1 style="font-size:28px;color:#1a1a1a;font-weight:400">Welcome to The Cultured Table</h1>
          <p style="color:#444;line-height:1.8">You're now subscribed to our monthly food and diet newsletter. Each month you'll receive the latest food trends, beautiful recipes, and culinary inspiration — delivered straight to your inbox on the 1st.</p>
          <p style="color:#444;line-height:1.8">Your first issue arrives next month. Until then, explore our latest issue at <a href="https://cookbookai1.netlify.app" style="color:#c8a96e">cookbookai1.netlify.app</a>.</p>
          <p style="color:#888;font-size:13px;margin-top:32px">Don't want these emails? <a href="https://cookbookai1.netlify.app/.netlify/functions/unsubscribe?email=${encodeURIComponent(email)}&token=${token}" style="color:#c8a96e">Unsubscribe here</a></p>
        </div>`,
      }),
    }).catch(() => {});
  }

  return new Response(JSON.stringify({ success: true, message: "Subscribed! Welcome aboard 🍽️" }), { headers });
};
