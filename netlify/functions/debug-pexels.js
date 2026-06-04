// netlify/functions/debug-pexels.js - temporary debug endpoint
export default async (req) => {
  const key = process.env.pexels_key;
  
  if (!key) {
    return new Response(JSON.stringify({ error: "pexels_key not found", env_keys: Object.keys(process.env).filter(k => k.toLowerCase().includes('pexel')) }), 
      { headers: { "Content-Type": "application/json" } });
  }

  try {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=fresh+food&per_page=3&orientation=landscape`,
      { headers: { Authorization: key } }
    );
    const data = await res.json();
    return new Response(JSON.stringify({ 
      status: res.status,
      key_length: key.length,
      photos_found: data.photos?.length || 0,
      first_url: data.photos?.[0]?.src?.large || null,
      error: data.error || null
    }), { headers: { "Content-Type": "application/json" } });
  } catch(e) {
    return new Response(JSON.stringify({ fetch_error: e.message }), 
      { headers: { "Content-Type": "application/json" } });
  }
};
