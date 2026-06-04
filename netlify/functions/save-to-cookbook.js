// netlify/functions/save-to-cookbook.js
// Looks up user by email in Supabase, appends recipe to their books array

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function supaFetch(method, path, body) {
  const url = SUPABASE_URL + path;
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=representation,resolution=merge-duplicates",
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

export default async (req) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };

  if (req.method === "OPTIONS") return new Response("", { status: 200, headers });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers });

  const { email, recipe } = await req.json().catch(() => ({}));

  if (!email || !recipe) {
    return new Response(JSON.stringify({ error: "Missing email or recipe" }), { status: 400, headers });
  }

  // 1. Look up user_id by email via Supabase auth admin API
  const authRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  }).then((r) => r.json());

  const user = authRes?.users?.[0];
  if (!user) {
    return new Response(
      JSON.stringify({ error: "No Fern account found for that email. Download the app first at app.clickpickandcook.com" }),
      { status: 404, headers }
    );
  }

  const userId = user.id;

  // 2. Pull current user_data row
  const rows = await supaFetch("GET", `/rest/v1/user_data?user_id=eq.${userId}&limit=1`);
  const row = rows?.[0] || {};
  const currentBooks = row.books || [];

  // 3. Build the recipe object in CPC format
  const newRecipe = {
    _id: `newsletter_${Date.now()}`,
    title: recipe.name,
    description: recipe.description,
    ingredients: recipe.ingredients || [],
    instructions: recipe.instructions || [],
    prepTime: recipe.prep_time || "",
    cookTime: recipe.cook_time || "",
    servings: recipe.servings || 4,
    tip: recipe.tip || "",
    source: "The Cultured Table Newsletter",
    saved_at: new Date().toISOString(),
    tags: ["newsletter", "cultured-table"],
  };

  // Avoid duplicates by title
  const alreadySaved = currentBooks.some((b) => b.title === newRecipe.title);
  if (alreadySaved) {
    return new Response(
      JSON.stringify({ success: true, message: "Already in your cookbook!" }),
      { headers }
    );
  }

  const updatedBooks = [...currentBooks, newRecipe];

  // 4. Push back to Supabase
  await supaFetch("POST", "/rest/v1/user_data?on_conflict=user_id", {
    user_id: userId,
    saved: row.saved || [],
    books: updatedBooks,
    meal_plan: row.meal_plan || {},
    shopping: row.shopping || [],
    remi_explicit: row.remi_explicit || {},
    remi_learned: row.remi_learned || {},
    followed_bloggers: row.followed_bloggers || [],
    user_stores: row.user_stores || [],
    circular: row.circular || [],
    activities: row.activities || [],
    updated_at: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({ success: true, message: `"${recipe.name}" saved to your Fern cookbook! Open the app to see it.` }),
    { headers }
  );
};
