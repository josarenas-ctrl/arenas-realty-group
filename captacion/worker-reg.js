const CORS = {
  "Access-Control-Allow-Origin": "https://www.arenasrealtygroup.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({}, CORS, { "Content-Type": "application/json" }),
  });
}

async function queryOne(env, sql, bind = []) {
  const { results } = await env.DB.prepare(sql).bind(...bind).all();
  return results?.[0] || null;
}

async function execute(env, sql, bind = []) {
  return env.DB.prepare(sql).bind(...bind).run();
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return json({ ok: true, ts: Date.now(), has_db: !!env.DB, has_r2: !!env.R2 });
    }

    if (url.pathname === "/api/auth/register" && request.method === "POST") {
      const { email, name } = await request.json();
      if (!email || !name) return json({ error: "email y nombre requeridos" }, 400);
      if (!env.DB) return json({ error: "DB no conectada" }, 500);

      const exists = await queryOne(env, "SELECT id FROM advisors WHERE email = ?", [email.toLowerCase().trim()]);
      if (exists) return json({ error: "Email ya registrado" }, 409);

      const token = crypto.randomUUID().replace(/-/g, "");
      await execute(env,
        `INSERT INTO advisors (email, name, session_token, created_at, verified) VALUES (?, ?, ?, ?, 1)`,
        [email.toLowerCase(), name.trim(), token, Date.now()]
      );

      return json({ ok: true, token, name: name.trim() });
    }

    return json({ error: "Ruta no encontrada" }, 404);
  },
};