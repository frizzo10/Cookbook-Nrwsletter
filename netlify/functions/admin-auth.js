// netlify/functions/admin-auth.js
import crypto from "crypto";

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const { password } = await req.json().catch(() => ({}));
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

  if (password !== ADMIN_PASSWORD) {
    return new Response(JSON.stringify({ error: "Invalid password" }), { status: 401, headers });
  }

  // Simple time-based token: hash of password + current day
  const today = new Date().toISOString().slice(0, 10);
  const token = crypto.createHmac("sha256", ADMIN_PASSWORD).update(today).digest("hex");

  return new Response(JSON.stringify({ success: true, token }), { headers });
};
