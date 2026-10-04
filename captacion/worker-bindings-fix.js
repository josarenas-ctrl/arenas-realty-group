export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': 'https://www.arenasrealtygroup.com',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const bind = await queryOne(
      env, 
      'SELECT binding_name, type FROM bindings WHERE binding_name = ?', 
      ['DB', 'R2']
    );

    // Verificar bindings
    if (!bind || bind.length === 0 || !bind.some(b => b.binding_name === 'DB' && b.type === 'd1') || !bind.some(b => b.binding_name === 'R2' && b.type === 'r2')) {
      return json({ error: 'Bindings no configurados' }, 500, cors);
    }

    const hasDB = bind.find(b => b.binding_name === 'DB');
    const hasR2 = bind.find(b => b.binding_name === 'R2');

    try {
      if (url.pathname === '/api/health') {
        return json({
          ok: true,
          bindings: {
            db: !!hasDB ? 'ok' : 'missing',
            r2: !!hasR2 ? 'ok' : 'missing'
          },
          ts: Date.now()
        }, 200, cors);
      }

      if (url.pathname === '/api/auth/request-code' && request.method === 'POST') {
        return await requestCode(request, env, cors);
      }
      if (url.pathname === '/api/auth/verify-code' && request.method === 'POST') {
        return await verifyCode(request, env, cors);
      }
      if (url.pathname === '/api/auth/register' && request.method === 'POST') {
        return await registerAdvisor(request, env, cors);
      }
      if (url.pathname === '/api/upload' && request.method === 'POST') {
        return await uploadBatch(request, env, cors);
      }
      if (url.pathname === '/api/publish' && request.method === 'POST') {
        return await publishBatch(request, env, cors);
      }

      return json({ error: 'Not Found' }, 404, cors);
    } catch (e) {
      return json({ error: e.message }, 500, cors);
    }
  },
};
