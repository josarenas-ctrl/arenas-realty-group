// arenas-captacion Worker — versión mínima funcional
// Solo diagnóstico. Sin D1, sin R2, sin Resend todavía.

const CORS = {
  "Access-Control-Allow-Origin": "https://www.arenasrealtygroup.com",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(obj, status, extra) {
  const headers = Object.assign({}, CORS, extra || {});
  headers["Content-Type"] = "application/json";
  return new Response(JSON.stringify(obj), { status: status || 200, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "arenas-captacion",
          ts: Date.now(),
          has_db: !!env.DB,
          has_r2: !!env.R2,
          has_resend: !!env.RESEND_API_KEY,
          has_github: !!env.GITHUB_TOKEN,
          admin_emails: env.ADMIN_EMAILS || "no-configurado"
        }, 200);
      }

      return json({ error: "ruta no encontrada" }, 404);
    } catch (e) {
      return json({ error: "error interno" }, 500);
    }
  }
};
