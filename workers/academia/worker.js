// Academia ARG — Worker API (extensión de arenas-auth)
// ES Module format + binding D1 nativo (env.DB). Sin token API.

// JWT_SECRET viene exclusivamente del secret de Cloudflare (env.JWT_SECRET).
// Sin fallback hardcodeado — si falta, el worker falla explicitamente.
const JWT_SECRET_KEY = env.JWT_SECRET;

function base64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return base64url(new Uint8Array(bits));
}
async function verifyPassword(password, storedHash, salt) {
  return (await hashPassword(password, salt)) === storedHash;
}
async function createJWT(payload) {
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(encoder.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000) + 86400 * 7 })));
  const key = await crypto.subtle.importKey('raw', encoder.encode(JWT_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(new Uint8Array(sig))}`;
}
async function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(JWT_SECRET_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const sig = base64urlDecode(parts[2]);
    if (!(await crypto.subtle.verify('HMAC', key, sig, encoder.encode(`${parts[0]}.${parts[1]}`)))) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1])));
    return payload.exp < Math.floor(Date.now()/1000) ? null : payload;
  } catch(e) { return null; }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' }
  });
}
async function getUserId(request) {
  const auth = request.headers.get('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return (await verifyJWT(auth.slice(7)))?.sub || null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Max-Age': '86400' } });
    }
    if (path === '/academia/health') {
      return json({ db_ready: !!env.DB });
    }

    // POST /academia/register
    if (path === '/academia/register' && request.method === 'POST') {
      try {
        const { email, name, password } = await request.json();
        if (!email || !name || !password || password.length < 6) return json({ error: 'Email, nombre y contraseña (mín 6 caracteres) requeridos' }, 400);
        const salt = crypto.randomUUID();
        const hash = await hashPassword(password, salt);
        const storedHash = `${salt}:${hash}`;
        try {
          await env.DB.prepare('INSERT INTO users (email, name, password_hash, role) VALUES (?, ?, ?, ?)').bind(email, name, storedHash, 'student').run();
        } catch (e) {
          if (String(e.message).includes('UNIQUE')) return json({ error: 'Este email ya está registrado' }, 409);
          throw e;
        }
        const created = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE LOWER(email)=LOWER(?)').bind(email).all();
        const u = (created.results || [])[0];
        const token = await createJWT({ sub: u.id, email, name, role: 'student' });
        return json({ token, user: { id: u.id, email, name, role: 'student' } }, 201);
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // POST /academia/login
    if (path === '/academia/login' && request.method === 'POST') {
      try {
        const { email, password } = await request.json();
        if (!email || !password) return json({ error: 'Email y contraseña requeridos' }, 400);
        const result = await env.DB.prepare('SELECT id, email, name, password_hash, role FROM users WHERE LOWER(email) = LOWER(?)').bind(email).all();
        if (!result.results || result.results.length === 0) return json({ error: 'Credenciales inválidas' }, 401);
        const user = result.results[0];
        const [salt, hash] = user.password_hash.split(':');
        if (!await verifyPassword(password, hash, salt)) return json({ error: 'Credenciales inválidas' }, 401);
        const token = await createJWT({ sub: user.id, email: user.email, name: user.name, role: user.role });
        return json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // GET /academia/me
    if (path === '/academia/me' && request.method === 'GET') {
      const userId = await getUserId(request);
      if (!userId) return json({ error: 'No autorizado' }, 401);
      try {
        const userResult = await env.DB.prepare('SELECT id, email, name, role FROM users WHERE id = ?').bind(userId).all();
        if (!userResult.results || userResult.results.length === 0) return json({ error: 'Usuario no encontrado' }, 404);
        const progressResult = await env.DB.prepare('SELECT module_id, score FROM progress WHERE user_id = ?').bind(userId).all();
        const progress = {};
        (progressResult.results || []).forEach(r => { progress['m' + r.module_id] = r.score; });
        return json({ user: userResult.results[0], progress });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // POST /academia/progress
    if (path === '/academia/progress' && request.method === 'POST') {
      const userId = await getUserId(request);
      if (!userId) return json({ error: 'No autorizado' }, 401);
      try {
        const { module_id, score } = await request.json();
        if (!module_id || score === undefined) return json({ error: 'module_id y score requeridos' }, 400);
        await env.DB.prepare("INSERT OR REPLACE INTO progress (user_id, module_id, score, completed_at) VALUES (?, ?, ?, datetime('now'))").bind(userId, module_id, score).run();
        return json({ ok: true });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // GET /academia/admin/students
    if (path === '/academia/admin/students' && request.method === 'GET') {
      const userId = await getUserId(request);
      if (!userId) return json({ error: 'No autorizado' }, 401);
      try {
        const r = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(userId).all();
        const user = (r.results || [])[0];
        if (!user || user.role !== 'admin') return json({ error: 'Solo administradores' }, 403);
        const result = await env.DB.prepare("SELECT u.id, u.name, u.email, u.role, u.created_at, COUNT(p.module_id) as modules_completed, ROUND(AVG(p.score)) as avg_score FROM users u LEFT JOIN progress p ON u.id = p.user_id GROUP BY u.id ORDER BY u.created_at DESC").all();
        return json({ students: result.results || [] });
      } catch(e) { return json({ error: e.message }, 500); }
    }

    // POST /academia/admin/reset-password
    if (path === '/academia/admin/reset-password' && request.method === 'POST') {
      const adminId = await getUserId(request);
      if (!adminId) return json({ error: 'No autorizado' }, 401);
      const r = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(adminId).all();
      const admin = (r.results || [])[0];
      if (!admin || admin.role !== 'admin') return json({ error: 'Solo administradores' }, 403);
      const { userId } = await request.json().catch(() => ({}));
      if (!userId) return json({ error: 'userId requerido' }, 400);
      const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
      let newPass = '';
      for (let i = 0; i < 8; i++) newPass += chars[Math.floor(Math.random() * chars.length)];
      const salt = crypto.randomUUID();
      const hash = await hashPassword(newPass, salt);
      await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(`${salt}:${hash}`, userId).run();
      return json({ new_password: newPass });
    }

    // POST /academia/admin/delete-user
    if (path === '/academia/admin/delete-user' && request.method === 'POST') {
      const adminId = await getUserId(request);
      if (!adminId) return json({ error: 'No autorizado' }, 401);
      const r = await env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(adminId).all();
      const admin = (r.results || [])[0];
      if (!admin || admin.role !== 'admin') return json({ error: 'Solo administradores' }, 403);
      const { userId } = await request.json().catch(() => ({}));
      if (!userId) return json({ error: 'userId requerido' }, 400);
      await env.DB.prepare('DELETE FROM progress WHERE user_id = ?').bind(userId).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
      return json({ ok: true });
    }

    // ===== Rutas originales =====

    if (path === "/auth") {
      const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorizeUrl.searchParams.set("scope", "repo,user");
      authorizeUrl.searchParams.set("redirect_uri", `${url.origin}/callback`);
      return Response.redirect(authorizeUrl.toString(), 302);
    }

    if (path === "/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Falta el código de autorización.", { status: 400 });
      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Accept": "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code: code }),
      });
      const tokenData = await tokenRes.json();
      if (tokenData.error) return new Response(`Error: ${tokenData.error_description || tokenData.error}`, { status: 400 });
      const token = tokenData.access_token;
      const html = `<!doctype html><html><body><script>
(function(){
  function receiveMessage(e) {
    window.opener.postMessage(
      'authorization:github:success:' + JSON.stringify({ token: '${token}', provider: 'github' }),
      e.origin
    );
    window.removeEventListener('message', receiveMessage, false);
  }
  window.addEventListener('message', receiveMessage, false);
  window.opener.postMessage('authorizing:github', '*');
})();
</script>Autenticando...</body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=UTF-8" } });
    }

    if (path === "/invitar") {
      if (request.method === "GET") return new Response(formularioInvitar(), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
      if (request.method === "POST") {
        const formData = await request.formData();
        const password = formData.get("password") || "";
        const username = (formData.get("username") || "").trim();
        if (password !== env.INVITE_PASSWORD) return new Response(formularioInvitar("Contraseña incorrecta."), { status: 401, headers: { "Content-Type": "text/html; charset=UTF-8" } });
        if (!username) return new Response(formularioInvitar("Escribe un usuario de GitHub."), { status: 400, headers: { "Content-Type": "text/html; charset=UTF-8" } });
        const ghRes = await fetch(`https://api.github.com/repos/josarenas-ctrl/arenas-realty-group/collaborators/${encodeURIComponent(username)}`, { method: "PUT", headers: { "Authorization": `Bearer ${env.GITHUB_ADMIN_TOKEN}`, "Accept": "application/vnd.github+json", "User-Agent": "arenas-auth", "X-GitHub-Api-Version": "2022-11-28" }, body: JSON.stringify({ permission: "push" }) });
        if (ghRes.status === 201) return new Response(formularioInvitar(`✅ Invitación enviada a "${username}".`, true), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
        if (ghRes.status === 204) return new Response(formularioInvitar(`✅ "${username}" ya tenía acceso.`, true), { headers: { "Content-Type": "text/html; charset=UTF-8" } });
        const err = await ghRes.text();
        return new Response(formularioInvitar(`❌ Error (${ghRes.status}): ${err}`), { status: 502, headers: { "Content-Type": "text/html; charset=UTF-8" } });
      }
    }

    return new Response("Arenas Realty Group — Worker API v2", { status: 200 });
  }
};

function formularioInvitar(mensaje, exito) {
  return `<!doctype html><html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Autorizar asesor — ARG</title>
<style>
  body{font-family:sans-serif;background:#FBF9F4;color:#0B2A4A;max-width:420px;margin:60px auto;padding:0 20px;}
  h1{font-size:1.3rem;margin-bottom:6px;}
  p.sub{color:#3D6690;font-size:0.9rem;margin-bottom:26px;}
  label{display:block;font-size:0.85rem;margin-bottom:6px;margin-top:16px;color:#3D6690;}
  input{width:100%;padding:10px;border:1px solid #0B2A4A33;font-size:1rem;box-sizing:border-box;}
  button{margin-top:22px;width:100%;padding:12px;background:#0B2A4A;color:#FBF9F4;border:none;font-size:1rem;cursor:pointer;}
  .msg{margin-top:18px;padding:12px;font-size:0.9rem;background:${exito?'#17A67922':'#D9A43822'};border-left:3px solid ${exito?'#17A679':'#D9A438'};}
</style></head><body>
  <h1>Autorizar acceso al panel</h1>
  <p class="sub">Pega el usuario de GitHub del asesor para darle acceso a /admin/.</p>
  <form method="POST">
    <label>Contraseña de administrador</label><input type="password" name="password" required>
    <label>Usuario de GitHub</label><input type="text" name="username" placeholder="ej: juanperez23" required>
    <button type="submit">Autorizar acceso</button>
  </form>
  ${mensaje?`<div class="msg">${mensaje}</div>`:''}
</body></html>`;
}