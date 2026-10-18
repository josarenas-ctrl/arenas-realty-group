// arenas-captacion Worker — Fase 1 (20261018)
// Cambios sobre la v2 en producción:
//  1) Límite de intentos en el código de acceso (5 fallos = bloqueo de 15 min).
//  2) Tokens de sesión y códigos guardados cifrados (SHA-256), no en texto claro.
//  3) Respaldo diario (cron) de la base de datos y de los archivos a un bucket aparte,
//     y ruta de admin para lanzarlo a mano.
// Todo lo demás (subida, publicación, alta de asesores) queda igual que la v2.

const REPO = "josarenas-ctrl/arenas-realty-group";
const BRANCH = "cloudflare-test";
const WORKER_VERSION = "20261018-f1";

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const CODE_MS = 10 * 60 * 1000;
const CODE_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const BACKUP_MAX_COPIES = 25;   // archivos nuevos por corrida (el resto sigue al día siguiente)
const BACKUP_KEEP_DB = 30;      // respaldos de base de datos que se conservan

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

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const codeHash = (email, code) => sha256hex(email + ":" + code);

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

// ---------- Respaldo ----------
// Base de datos: JSON sin secretos (sin códigos ni tokens). Archivos: copia incremental.
async function runBackup(env) {
  if (!env.BACKUP) return { ok: false, error: "Bucket de respaldo no configurado" };
  const stamp = new Date().toISOString();
  const day = stamp.slice(0, 10);

  const advisors = (await env.DB.prepare(
    "SELECT id, email, name, verified, code_expires, session_expires, created_at, code_attempts, locked_until FROM advisors"
  ).all()).results || [];
  const batches = (await env.DB.prepare("SELECT * FROM batches").all()).results || [];
  await env.BACKUP.put("db/" + day + ".json", JSON.stringify({ generado: stamp, advisors, batches }, null, 1));

  // Retención: se conservan los últimos BACKUP_KEEP_DB respaldos de la base
  const dbList = await env.BACKUP.list({ prefix: "db/" });
  const dbKeys = dbList.objects.map((o) => o.key).sort();
  const old = dbKeys.slice(0, Math.max(0, dbKeys.length - BACKUP_KEEP_DB));
  if (old.length) await env.BACKUP.delete(old);

  // Archivos: copiar los que faltan (o cambiaron de tamaño), con tope por corrida
  const have = new Map();
  let c1;
  do {
    const l = await env.BACKUP.list({ prefix: "files/", cursor: c1 });
    for (const o of l.objects) have.set(o.key.slice(6), o.size);
    c1 = l.truncated ? l.cursor : undefined;
  } while (c1);

  let copied = 0, already = 0, pending = 0, c2;
  do {
    const l = await env.R2.list({ cursor: c2 });
    for (const o of l.objects) {
      if (have.get(o.key) === o.size) { already++; continue; }
      if (copied >= BACKUP_MAX_COPIES) { pending++; continue; }
      const obj = await env.R2.get(o.key);
      if (obj) { await env.BACKUP.put("files/" + o.key, await obj.arrayBuffer()); copied++; }
    }
    c2 = l.truncated ? l.cursor : undefined;
  } while (c2);

  const res = { ok: true, fecha: stamp, advisors: advisors.length, batches: batches.length, archivos_copiados: copied, archivos_ya_respaldados: already, archivos_pendientes: pending };
  await env.BACKUP.put("estado/ultimo.json", JSON.stringify(res));
  return res;
}

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
          has_backup: !!env.BACKUP,
          has_resend: !!env.RESEND_API_KEY,
          has_github: !!env.GITHUB_TOKEN,
          session_days: SESSION_DAYS
        }, 200, cors);
      }

      if (path === "/api/auth/request-code" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const email = normEmail(body.email);
        if (!isEmail(email)) return json({ error: "email requerido" }, 400, cors);

        let row = (await env.DB.prepare("SELECT id, name, code_expires, locked_until FROM advisors WHERE email = ?")
          .bind(email).all()).results?.[0];

        // Los correos de ADMIN_EMAILS se dan de alta solos la primera vez
        if (!row && adminList(env).includes(email)) {
          await env.DB.prepare(
            "INSERT INTO advisors (email, name, session_token, session_expires, created_at, verified) VALUES (?, ?, ?, ?, ?, 1)"
          ).bind(email, email.split("@")[0], newToken(), 0, Date.now()).run();
          row = (await env.DB.prepare("SELECT id, name, code_expires, locked_until FROM advisors WHERE email = ?")
            .bind(email).all()).results?.[0];
        }

        if (!row) return json({ error: "Email no registrado" }, 403, cors);

        if (row.locked_until && row.locked_until > Date.now()) {
          const min = Math.ceil((row.locked_until - Date.now()) / 60000);
          return json({ error: "Acceso bloqueado por intentos fallidos. Intenta de nuevo en " + min + " min" }, 429, cors);
        }

        // Antirrebote: un código nuevo cada 60 s como máximo
        if (row.code_expires && row.code_expires - CODE_MS + CODE_COOLDOWN_MS > Date.now()) {
          return json({ error: "Espera un minuto antes de pedir otro código" }, 429, cors);
        }

        if (!env.RESEND_API_KEY) return json({ error: "Correo no configurado" }, 500, cors);

        const code = newCode();
        await env.DB.prepare("UPDATE advisors SET code = ?, code_expires = ?, code_attempts = 0 WHERE email = ?")
          .bind(await codeHash(email, code), Date.now() + CODE_MS, email).run();

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

        const a = (await env.DB.prepare(
          "SELECT id, code, code_expires, name, code_attempts, locked_until FROM advisors WHERE email = ?"
        ).bind(email).all()).results?.[0];
        const invalid = () => json({ error: "Código inválido o expirado" }, 401, cors);
        if (!a) return invalid();

        if (a.locked_until && a.locked_until > Date.now()) {
          const min = Math.ceil((a.locked_until - Date.now()) / 60000);
          return json({ error: "Acceso bloqueado por intentos fallidos. Intenta de nuevo en " + min + " min" }, 429, cors);
        }
        if (!a.code || !a.code_expires || a.code_expires < Date.now()) return invalid();

        if (a.code !== await codeHash(email, code)) {
          const attempts = (a.code_attempts || 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            // Se invalida el código y se bloquea el acceso un rato
            await env.DB.prepare("UPDATE advisors SET code = NULL, code_expires = NULL, code_attempts = 0, locked_until = ? WHERE id = ?")
              .bind(Date.now() + LOCK_MS, a.id).run();
            return json({ error: "Demasiados intentos. Acceso bloqueado 15 min" }, 429, cors);
          }
          await env.DB.prepare("UPDATE advisors SET code_attempts = ? WHERE id = ?").bind(attempts, a.id).run();
          return json({ error: "Código inválido. Te quedan " + (MAX_ATTEMPTS - attempts) + " intentos" }, 401, cors);
        }

        const token = newToken();
        await env.DB.prepare(
          "UPDATE advisors SET code = NULL, code_expires = NULL, code_attempts = 0, locked_until = NULL, session_token = ?, session_expires = ? WHERE id = ?"
        ).bind(await sha256hex(token), Date.now() + SESSION_MS, a.id).run();

        return json({ ok: true, token, email, name: a.name || "", expires_days: SESSION_DAYS }, 200, cors);
      }

      // ---------- Protegidas ----------
      const auth = request.headers.get("Authorization") || "";
      if (!auth.startsWith("Bearer ")) return json({ error: "Auth requerido" }, 401, cors);
      const token = auth.slice(7).trim();

      const me = (await env.DB.prepare("SELECT id, email, name, session_expires FROM advisors WHERE session_token = ?")
        .bind(await sha256hex(token)).all()).results?.[0];
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

      // Respaldo a mano (solo admin)
      if (path === "/api/admin/backup" && request.method === "POST") {
        if (!isAdmin) return json({ error: "No autorizado" }, 403, cors);
        return json(await runBackup(env), 200, cors);
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
  },

  // Cron diario: respaldo de la base de datos y de los archivos
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runBackup(env)
        .then((r) => console.log("Respaldo:", JSON.stringify(r)))
        .catch((e) => console.error("Respaldo falló:", e && e.message ? e.message : e))
    );
  }
};
