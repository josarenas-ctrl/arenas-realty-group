// arenas-captacion Worker — v2 (20261016)
// API de captación: login por código al correo, subida de batches a D1/R2
// y publicación del JSON de la propiedad en el repo (sin publicar: publicada=false).
// Las páginas HTML las genera el workflow build-properties al detectar el JSON nuevo.
// La app (PWA) se sirve desde Cloudflare Pages en /captacion/, NO desde este Worker.

const REPO = "josarenas-ctrl/arenas-realty-group";
const BRANCH = "cloudflare-test";
const WORKER_VERSION = "20261016-v2";

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;

const ALLOWED_ORIGINS = [
  "https://www.arenasrealtygroup.com",
  "https://arenasrealtygroup.com",
  "https://arenas-realty-group.pages.dev"
];

function corsFor(request) {
  const origin = request.headers.get("Origin") || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

const normEmail = (e) => String(e || "").toLowerCase().trim();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

function adminList(env) {
  return String(env.ADMIN_EMAILS || "")
    .split(",")
    .map((s) => s.toLowerCase().trim())
    .filter(Boolean);
}

function newToken() {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function newCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(100000 + n);
}

function slugify(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

const safeName = (s) => String(s || "").replace(/[^\w.\- ]/g, "_").slice(0, 120);
const validBatch = (b) => typeof b === "string" && /^[A-Za-z0-9_-]{6,60}$/.test(b);

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// Campos que se publican en el JSON de la propiedad (mismos nombres que usa el CMS / build-properties)
const PUB_FIELDS = [
  "titulo", "operacion", "tipo", "precio", "ubicacion", "mapa_url",
  "area_terreno", "area_construccion", "habitaciones", "banos", "estacionamientos",
  "descripcion", "caracteristicas", "video_url", "asesor", "whatsapp_asesor"
];

export default {
  async fetch(request, env) {
    const cors = corsFor(request);
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      return new Response("Not found", { status: 404, headers: cors });
    }

    try {
      // ---------- Públicas ----------
      if (path === "/api/health") {
        return json({
          ok: true,
          version: WORKER_VERSION,
          ts: Date.now(),
          has_db: !!env.DB,
          has_r2: !!env.R2,
          has_resend: !!env.RESEND_API_KEY,
          has_github: !!env.GITHUB_TOKEN,
          session_days: SESSION_DAYS
        }, 200, cors);
      }

      if (path === "/api/auth/request-code" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = normEmail(body.email);
        if (!isEmail(email)) return json({ error: "email requerido" }, 400, cors);

        let row = (await env.DB.prepare("SELECT id, name, code_expires FROM advisors WHERE email = ?")
          .bind(email).all()).results?.[0];

        // Los correos de ADMIN_EMAILS se dan de alta solos la primera vez
        if (!row && adminList(env).includes(email)) {
          await env.DB.prepare(
            "INSERT INTO advisors (email, name, session_token, session_expires, created_at, verified) VALUES (?, ?, ?, ?, ?, 1)"
          ).bind(email, email.split("@")[0], newToken(), 0, Date.now()).run();
          row = (await env.DB.prepare("SELECT id, name, code_expires FROM advisors WHERE email = ?")
            .bind(email).all()).results?.[0];
        }

        if (!row) return json({ error: "Email no registrado" }, 403, cors);

        // Antirrebote: un código nuevo cada 60 s como máximo
        if (row.code_expires && row.code_expires - CODE_MS + CODE_COOLDOWN_MS > Date.now()) {
          return json({ error: "Espera un minuto antes de pedir otro código" }, 429, cors);
        }

        if (!env.RESEND_API_KEY) return json({ error: "Correo no configurado" }, 500, cors);

        const code = newCode();
        await env.DB.prepare("UPDATE advisors SET code = ?, code_expires = ? WHERE email = ?")
          .bind(code, Date.now() + CODE_MS, email).run();

        const resp = await fetch("https://api.resend.com/emails", {
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
        if (!resp.ok) {
          console.error("Resend falló", resp.status, (await resp.text()).slice(0, 300));
          return json({ error: "No se pudo enviar el correo" }, 502, cors);
        }
        return json({ ok: true, sent: true }, 200, cors);
      }

      if (path === "/api/auth/verify-code" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = normEmail(body.email);
        const code = String(body.code || "").trim();
        if (!email || !code) return json({ error: "Faltan datos" }, 400, cors);

        const a = (await env.DB.prepare("SELECT id, code, code_expires, name FROM advisors WHERE email = ?")
          .bind(email).all()).results?.[0];
        if (!a || !a.code || a.code_expires < Date.now() || a.code !== code) {
          return json({ error: "Código inválido o expirado" }, 401, cors);
        }

        const token = newToken();
        await env.DB.prepare("UPDATE advisors SET code = NULL, code_expires = NULL, session_token = ?, session_expires = ? WHERE id = ?")
          .bind(token, Date.now() + SESSION_MS, a.id).run();

        return json({ ok: true, token, email, name: a.name || "", expires_days: SESSION_DAYS }, 200, cors);
      }

      // ---------- Protegidas ----------
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Auth requerido" }, 401, cors);
      const token = auth.slice(7).trim();

      const me = (await env.DB.prepare("SELECT id, email, name, session_expires FROM advisors WHERE session_token = ?")
        .bind(token).all()).results?.[0];
      if (!me) return json({ error: "Sesión inválida" }, 401, cors);
      if (!me.session_expires || me.session_expires < Date.now()) {
        return json({ error: "Sesión expirada" }, 401, cors);
      }
      const isAdmin = adminList(env).includes(String(me.email || "").toLowerCase());

      // Valida la sesión (la app lo usa al abrir)
      if (path === "/api/me" && request.method === "GET") {
        return json({ ok: true, email: me.email, name: me.name || "", admin: isAdmin }, 200, cors);
      }

      // Alta de asesores (solo admin)
      if (path === "/api/admin/advisor" && request.method === "POST") {
        if (!isAdmin) return json({ error: "No autorizado" }, 403, cors);
        const body = await request.json().catch(() => ({}));
        const email = normEmail(body.email);
        const name = String(body.name || "").trim();
        if (!isEmail(email) || !name) return json({ error: "email y nombre requeridos" }, 400, cors);

        const exists = (await env.DB.prepare("SELECT id FROM advisors WHERE email = ?").bind(email).all()).results?.length;
        if (exists) return json({ error: "Email ya registrado" }, 409, cors);

        await env.DB.prepare(
          "INSERT INTO advisors (email, name, session_token, session_expires, created_at, verified) VALUES (?, ?, ?, ?, ?, 1)"
        ).bind(email, name, newToken(), 0, Date.now()).run();
        return json({ ok: true, email, name }, 200, cors);
      }

      // Subida de un batch (ficha + documentos + fotos)
      if (path === "/api/upload" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        if (!body) return json({ error: "JSON inválido" }, 400, cors);
        const { batch, ficha, docs = [], fotos = [] } = body;
        if (!validBatch(batch) || !ficha) return json({ error: "batch y ficha requeridos" }, 400, cors);

        const prev = (await env.DB.prepare("SELECT id, advisor_id FROM batches WHERE ref = ? LIMIT 1")
          .bind(batch).all()).results?.[0];
        if (prev && prev.advisor_id !== me.id) return json({ error: "Batch de otro asesor" }, 403, cors);

        const now = Date.now();
        if (prev) {
          await env.DB.prepare("UPDATE batches SET ficha_json = ?, updated_at = ? WHERE id = ?")
            .bind(JSON.stringify(ficha), now, prev.id).run();
        } else {
          await env.DB.prepare(
            "INSERT INTO batches (advisor_id, ref, ficha_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
          ).bind(me.id, batch, JSON.stringify(ficha), now, now).run();
        }

        let saved = 0;
        if (env.R2) {
          const puts = [];
          for (const d of docs) {
            if (!d?.data_b64 || !d?.nuevo) continue;
            try { puts.push(env.R2.put(`${batch}/docs/${safeName(d.nuevo)}`, b64ToBytes(d.data_b64))); saved++; } catch (e) {}
          }
          for (const f of fotos) {
            if (!f?.data_b64 || !f?.uuid) continue;
            try {
              const ext = String(f.ext || "jpg").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "jpg";
              puts.push(env.R2.put(`${batch}/fotos/${safeName(f.uuid)}.${ext}`, b64ToBytes(f.data_b64)));
              saved++;
            } catch (e) {}
          }
          await Promise.all(puts);
        }
        return json({ ok: true, batch, archivos_guardados: saved }, 200, cors);
      }

      // Publicar: crea propiedades/<slug>.json (publicada=false) en el repo
      if (path === "/api/publish" && request.method === "POST") {
        const body = await request.json().catch(() => null);
        const batch = body?.batch;
        if (!validBatch(batch)) return json({ error: "batch requerido" }, 400, cors);

        const rec = (await env.DB.prepare(
          "SELECT id, ficha_json, pushed_at FROM batches WHERE ref = ? AND advisor_id = ? LIMIT 1"
        ).bind(batch, me.id).all()).results?.[0];
        if (!rec) return json({ error: "Batch no encontrado" }, 404, cors);
        if (rec.pushed_at) return json({ error: "Ya publicado" }, 409, cors);

        let ficha;
        try { ficha = JSON.parse(rec.ficha_json); } catch (e) { return json({ error: "ficha corrupta" }, 500, cors); }

        // Acepta ficha con bloque "pub" o campos planos
        const src = ficha.pub && typeof ficha.pub === "object" ? ficha.pub : ficha;
        const slug = slugify(src.slug || src.titulo);
        if (!slug) return json({ error: "Falta título o slug" }, 400, cors);
        if (!src.titulo || !src.precio) return json({ error: "Falta título o precio" }, 400, cors);

        const publicJSON = {};
        for (const k of PUB_FIELDS) {
          if (src[k] != null && src[k] !== "") publicJSON[k] = k === "precio" ? String(src[k]) : src[k];
        }
        publicJSON.fotos = [];
        publicJSON.publicada = false;

        if (!env.GITHUB_TOKEN) return json({ error: "GitHub no configurado" }, 500, cors);

        const api = `https://api.github.com/repos/${REPO}/contents/propiedades/${slug}.json`;
        const gh = {
          "Authorization": "Bearer " + env.GITHUB_TOKEN,
          "Accept": "application/vnd.github+json",
          "User-Agent": "arenas-captacion-worker"
        };

        // Nunca pisar una propiedad existente (podría traer fotos y estar publicada)
        const getResp = await fetch(api + "?ref=" + BRANCH, { headers: gh });
        if (getResp.ok) return json({ error: "Ya existe una propiedad con ese slug: " + slug }, 409, cors);
        if (getResp.status !== 404) {
          console.error("GitHub GET falló", getResp.status);
          return json({ error: "No se pudo consultar GitHub" }, 502, cors);
        }

        const putResp = await fetch(api, {
          method: "PUT",
          headers: { ...gh, "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "Captación: " + slug,
            content: utf8ToB64(JSON.stringify(publicJSON, null, 2)),
            branch: BRANCH
          })
        });
        const putData = await putResp.json().catch(() => ({}));
        if (!putResp.ok) {
          console.error("GitHub PUT falló", putResp.status, putData.message);
          return json({ error: "GitHub: " + (putData.message || putResp.status) }, 502, cors);
        }

        await env.DB.prepare("UPDATE batches SET pushed_at = ?, github_commit_sha = ? WHERE id = ?")
          .bind(Date.now(), putData.commit?.sha || null, rec.id).run();

        return json({ ok: true, path: "propiedades/" + slug + ".json" }, 200, cors);
      }

      return json({ error: "Ruta no encontrada" }, 404, cors);
    } catch (e) {
      console.error("Error en Worker:", e && e.message ? e.message : e);
      return json({ error: "Error interno" }, 500, cors);
    }
  }
};
