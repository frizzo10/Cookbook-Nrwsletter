// temp debug - shows raw newsletter blob
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const store = getStore("newsletters");
  const nl = await store.get("latest", { type: "json" }).catch(() => null);
  if (!nl) return new Response(JSON.stringify({ error: "no newsletter found" }), { headers: { "Content-Type": "application/json" } });
  
  return new Response(JSON.stringify({
    month: nl.month,
    year: nl.year,
    hero_image: nl.hero_image,
    recipe_images: nl.recipes?.map(r => ({ name: r.name, image: r.image }))
  }), { headers: { "Content-Type": "application/json" } });
};
