// arenas-captacion Worker — Fase 2 (sirve frontend desde R2 + API)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

const STATIC_PATHS = {
  "/": "static/index.html",
  "/captacion/": "static/index.html",
  "/index.html": "static/index.html",
  "/sw.js": "static/sw.js",
  "/manifest.webmanifest": "static/manifest.webmanifest",
  "/icon-192.png": "static/icon-192.png",
  "/icon-512.png": "static/icon-512.png",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function json(data, status, headers) {
  const h = { ...CORS, ...(headers || {}), "Content-Type": "application/json" };
  return new Response(JSON.stringify(data), { status: status || 200, headers: h });
}

function staticResponse(body, contentType) {
  return new Response(body, {
    headers: { ...CORS, "Content-Type": contentType, "Cache-Control": "public, max-age=3600" }
  });
}

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const WORKER_VERSION = "20261006-0425"; // cache bust

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Servir archivos estáticos desde R2 (sin auth)
    if (request.method === "GET" && STATIC_PATHS[path]) {
      const object = await env.R2.get(STATIC_PATHS[path]);
      if (object) {
        const ext = path.split(".").pop();
        let contentType = MIME["." + ext] || "application/octet-stream";
        // Root path fix
        if (path === "/" || path === "/captacion/") contentType = MIME[".html"];
        return staticResponse(object.body, contentType);
      }
      return new Response("Not found", { status: 404, headers: CORS });
    }

    // API routes (requieren auth excepto health, register, request-code, verify-code)
    if (path.startsWith("/api/")) {
      try {
        // Health
        if (path === "/api/health") {
          return json({
            ok: true,
            ts: Date.now(),
            has_db: !!env.DB,
            has_r2: !!env.R2,
            has_resend: !!env.RESEND_API_KEY,
            has_github: !!env.GITHUB_TOKEN,
            session_days: SESSION_DAYS
          });
        }

        // Register
        if (path === "/api/auth/register" && request.method === "POST") {
          const { email, name } = await request.json();
          if (!email || !name) return json({ error: "email y nombre requeridos" }, 400);

          const exists = await env.DB.prepare("SELECT id FROM advisors WHERE email = ?")
            .bind(email.toLowerCase().trim()).all();
          if (exists.results?.length) return json({ error: "Email ya registrado" }, 409);

          const token = crypto.randomUUID().replace(/-/g, "");
          const expires = Date.now() + SESSION_MS;

          await env.DB.prepare(
            "INSERT INTO advisors (email, name, session_token, session_expires, created_at, verified) VALUES (?, ?, ?, ?, ?, 1)"
          ).bind(email.toLowerCase(), name.trim(), token, expires, Date.now()).run();

          return json({ ok: true, token, name: name.trim(), expires_days: SESSION_DAYS });
        }

        // Request code
        if (path === "/api/auth/request-code" && request.method === "POST") {
          const { email } = await request.json();
          if (!email) return json({ error: "email requerido" }, 400);

          const advisor = await env.DB.prepare("SELECT id, name FROM advisors WHERE email = ?")
            .bind(email.toLowerCase().trim()).all();

          if (!advisor.results?.length) return json({ error: "Email no registrado" }, 403);

          const code = String(Math.floor(100000 + Math.random() * 900000));
          const expires = Date.now() + 10 * 60 * 1000;

          await env.DB.prepare("UPDATE advisors SET code = ?, code_expires = ? WHERE email = ?")
            .bind(code, expires, email.toLowerCase()).run();

          if (env.RESEND_API_KEY) {
            try {
              await fetch("https://api.resend.com/emails", {
                method: "POST",
                headers: {
                  "Authorization": "Bearer " + env.RESEND_API_KEY,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  from: "Arenas Captación <noreply@arenasrealtygroup.com>",
                  to: email,
                  subject: "Tu código de acceso",
                  html: `<p>Tu código: <strong>${code}</strong> (válido 10 min)</p>`
                })
              });
            } catch(e) { /* ignore */ }
          }

          return json({ ok: true, sent: !!env.RESEND_API_KEY });
        }

        // Verify code
        if (path === "/api/auth/verify-code" && request.method === "POST") {
          const { email, code } = await request.json();
          if (!email || !code) return json({ error: "Faltan datos" }, 400);

          const advisor = await env.DB.prepare("SELECT id, code, code_expires, name FROM advisors WHERE email = ?")
            .bind(email.toLowerCase().trim()).all();

          if (!advisor.results?.length) return json({ error: "Código inválido" }, 401);
          const a = advisor.results[0];
          if (a.code_expires < Date.now() || a.code !== code) {
            return json({ error: "Código inválido o expirado" }, 401);
          }

          const token = crypto.randomUUID().replace(/-/g, "");
          const expires = Date.now() + SESSION_MS;

          await env.DB.prepare("UPDATE advisors SET code = NULL, session_token = ?, session_expires = ? WHERE id = ?")
            .bind(token, expires, a.id).run();

          return json({ ok: true, token, name: a.name || "", expires_days: SESSION_DAYS });
        }

        // Protected routes - check auth
        const auth = request.headers.get("Authorization");
        if (!auth || !auth.startsWith("Bearer ")) return json({ error: "Auth requerido" }, 401);

        const token = auth.replace("Bearer ", "");
        const advisor = await env.DB.prepare("SELECT id, session_expires FROM advisors WHERE session_token = ?")
          .bind(token).all();

        if (!advisor.results?.length) return json({ error: "Sesión inválida" }, 401);
        if (advisor.results[0].session_expires < Date.now()) {
          return json({ error: "Sesión expirada" }, 401);
        }

        // Upload
        if (path === "/api/upload" && request.method === "POST") {
          const body = await request.json();
          const { batch, ficha, docs = [], fotos = [] } = body;
          if (!batch || !ficha) return json({ error: "batch y ficha requeridos" }, 400);

          await env.DB.prepare(
            "INSERT INTO batches (advisor_id, ref, ficha_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(ref) DO UPDATE SET ficha_json=excluded.ficha_json, updated_at=?"
          ).bind(advisor.results[0].id, batch, JSON.stringify(ficha), Date.now(), Date.now()).run();

          if (env.R2) {
            const uploads = [];
            for (const d of docs) {
              if (!d.data_b64 || !d.nuevo) continue;
              try {
                const buffer = Uint8Array.from(atob(d.data_b64), c => c.charCodeAt(0));
                uploads.push(env.R2.put(`${batch}/docs/${d.nuevo}`, buffer));
              } catch(e) {}
            }
            for (const f of fotos) {
              if (!f.data_b64 || !f.uuid) continue;
              try {
                const buffer = Uint8Array.from(atob(f.data_b64), c => c.charCodeAt(0));
                uploads.push(env.R2.put(`${batch}/fotos/${f.uuid}.${f.ext || "jpg"}`, buffer));
              } catch(e) {}
            }
            await Promise.all(uploads);
          }

          return json({ ok: true, batch });
        }

        // Publish
        if (path === "/api/publish" && request.method === "POST") {
          let batch;
          let bodyText = "";
          try {
            bodyText = await request.text();
            const body = JSON.parse(bodyText);
            batch = body?.batch;
          } catch (e) {
            return json({ error: "JSON inválido: " + e.message, body: bodyText.slice(0, 200) }, 400);
          }
          if (!batch) return json({ error: "batch requerido" }, 400);
          
          const record = await env.DB.prepare(
            "SELECT id, ficha_json, pushed_at FROM batches WHERE ref = ? AND advisor_id = ? LIMIT 1"
          ).bind(batch, advisor.results[0].id).all();

          if (!record.results?.length) return json({ error: "Batch no encontrado" }, 404);
          const rec = record.results[0];
          if (rec.pushed_at) return json({ error: "Ya publicado" }, 409);

          let ficha;
          try { ficha = JSON.parse(rec.ficha_json); } catch(e) { return json({ error: "ficha corrupta" }, 500); }

          if (!ficha.pub?.slug) return json({ error: "Falta slug" }, 400);
          if (!ficha.pub?.titulo || !ficha.pub?.precio) return json({ error: "Falta título o precio" }, 400);

          const publicJSON = {
            titulo: ficha.pub.titulo,
            operacion: ficha.pub.operacion,
            tipo: ficha.pub.tipo,
            precio: String(ficha.pub.precio),
            ubicacion: ficha.pub.ubicacion || "",
            descripcion: ficha.pub.descripcion || "",
            publicada: false
          };

          if (!env.GITHUB_TOKEN) return json({ error: "GitHub no configurado" }, 500);

          const api = `https://api.github.com/repos/josarenas-ctrl/arenas-realty-group/contents/propiedades/${encodeURIComponent(ficha.pub.slug)}.json`;
          const content = btoa(unescape(encodeURIComponent(JSON.stringify(publicJSON, null, 2))));

          // Get existing file SHA if it exists
          let fileSha = null;
          const getResp = await fetch(api + "?ref=cloudflare-test", {
            headers: { "Authorization": "token " + env.GITHUB_TOKEN, "User-Agent": "arenas-captacion-worker" }
          });
          if (getResp.ok) {
            const getData = await getResp.json();
            fileSha = getData.sha;
          }

          const putBody = {
            message: "Captación: " + ficha.pub.slug,
            content: content,
            branch: "cloudflare-test"
          };
          if (fileSha) putBody.sha = fileSha;

          const putResp = await fetch(api, {
                      method: "PUT",
                      headers: {
                        "Authorization": "token " + env.GITHUB_TOKEN,
                        "Content-Type": "application/json",
                        "User-Agent": "arenas-captacion-worker"
                      },
                      body: JSON.stringify(putBody)
                    });
          let putData;
          try {
            const putText = await putResp.text();
            putData = JSON.parse(putText);
          } catch (e) {
            throw new Error("GitHub response no es JSON: " + putResp.status + " " + putResp.statusText + " | err: " + e.message);
          }
          if (!putResp.ok) throw new Error("GitHub: " + (putData.message || putResp.status));

          await env.DB.prepare(
            "UPDATE batches SET pushed_at = ?, github_commit_sha = ? WHERE id = ?"
          ).bind(Date.now(), putData.commit.sha, rec.id).run();

          return json({ ok: true, path: "propiedades/" + ficha.pub.slug + ".json" });
        }

        return json({ error: "Ruta no encontrada" }, 404);

      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // Rutas no encontradas
    return new Response("Not found", { status: 404, headers: CORS });
  }
};