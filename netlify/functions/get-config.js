// netlify/functions/get-config.js
// Public config values safe to expose to the browser. The Turnstile site
// key is meant to be public (only the secret key is sensitive) — this
// just avoids hardcoding it into HTML so it can be rotated via env vars.
export default async () => {
  return new Response(
    JSON.stringify({
      turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || "",
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300",
      },
    }
  );
};
