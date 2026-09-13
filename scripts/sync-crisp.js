const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const PROP_DIR = path.join(ROOT, 'propiedades');
const SITE_URL = 'https://www.arenasrealtygroup.com';

// Variables de entorno (se configuran como secrets en GitHub, nunca escritas aquí)
const WEBSITE_ID = process.env.CRISP_WEBSITE_ID;   // 56a43fb2-a4a7-44da-b565-c4f817a0294e
const TOKEN_ID   = process.env.CRISP_TOKEN_ID;
const TOKEN_KEY  = process.env.CRISP_TOKEN_KEY;
const ARTICLE_ID = process.env.CRISP_ARTICLE_ID;
const LOCALE     = process.env.CRISP_LOCALE || 'es';

function formatPrecio(precio){
  if(precio == null || precio === '') return '';
  const digitos = String(precio).replace(/[^\d]/g, '');
  if(!digitos) return String(precio);
  const num = parseInt(digitos, 10);
  if(isNaN(num)) return String(precio);
  const conPuntos = num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `USD ${conPuntos}`;
}

// Arma un bloque de texto con TODOS los datos de una propiedad, sin dejar nada por fuera.
function bloquePropiedad(slug, d){
  const specs = [];
  if(d.area_terreno) specs.push(`${d.area_terreno} m² de terreno`);
  if(d.area_construccion) specs.push(`${d.area_construccion} m² de construcción`);
  if(d.habitaciones) specs.push(`${d.habitaciones} habitaciones`);
  if(d.banos) specs.push(`${d.banos} baños`);
  if(d.estacionamientos) specs.push(`${d.estacionamientos} puestos de estacionamiento`);

  const caracteristicas = (d.caracteristicas || '')
    .split('\n').map(s => s.trim()).filter(Boolean);

  const lineas = [
    `### ${d.titulo || 'Propiedad sin título'}`,
    `- Operación: ${d.operacion || 'No especificada'}`,
    `- Tipo de propiedad: ${d.tipo || 'No especificado'}`,
    `- Precio: ${formatPrecio(d.precio) || 'Consultar precio'}`,
    `- Ubicación: ${d.ubicacion || 'No especificada'}`,
  ];
  if(specs.length) lineas.push(`- Detalles físicos: ${specs.join(', ')}`);
  if(d.descripcion) lineas.push(`- Descripción completa: ${d.descripcion}`);
  if(caracteristicas.length) lineas.push(`- Características adicionales: ${caracteristicas.join(', ')}`);
  if(d.video_url) lineas.push(`- Video de la propiedad: ${d.video_url}`);
  lineas.push(`- Asesor a cargo: ${d.asesor || 'Arenas Realty Group'}`);
  if(d.whatsapp_asesor) lineas.push(`- WhatsApp del asesor: ${d.whatsapp_asesor}`);
  lineas.push(`- Link de la página de esta propiedad: ${SITE_URL}/propiedades/${slug}.html`);

  return lineas.join('\n');
}

function construirContenidoCompleto(){
  if(!fs.existsSync(PROP_DIR)){
    return '# Catálogo de propiedades — Arenas Realty Group\n\nActualmente no hay propiedades cargadas.';
  }

  const archivos = fs.readdirSync(PROP_DIR).filter(f => f.endsWith('.json'));
  const bloques = [];

  archivos.forEach(nombre => {
    const slug = nombre.replace(/\.json$/, '');
    let data;
    try{
      data = JSON.parse(fs.readFileSync(path.join(PROP_DIR, nombre), 'utf-8'));
    }catch(e){
      return;
    }
    if(!data || typeof data !== 'object') return;
    if(data.publicada === false) return; // Solo propiedades activas/publicadas

    bloques.push(bloquePropiedad(slug, data));
  });

  const encabezado = [
    '# Catálogo de propiedades — Arenas Realty Group',
    '',
    'Este artículo se actualiza automáticamente cada vez que se publica o edita una propiedad.',
    'No editar a mano: los cambios se sobrescriben en la próxima sincronización.',
    '',
    `Total de propiedades activas: ${bloques.length}`,
    ''
  ].join('\n');

  return bloques.length
    ? `${encabezado}\n${bloques.join('\n\n---\n\n')}`
    : `${encabezado}\nActualmente no hay propiedades publicadas.`;
}

function actualizarArticuloCrisp(contenido){
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ content: contenido });
    const auth = Buffer.from(`${TOKEN_ID}:${TOKEN_KEY}`).toString('base64');

    const options = {
      hostname: 'api.crisp.chat',
      path: `/v1/website/${WEBSITE_ID}/helpdesk/locale/${LOCALE}/article/${ARTICLE_ID}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
        'X-Crisp-Tier': 'website',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if(res.statusCode >= 200 && res.statusCode < 300){
          console.log('Artículo de Crisp actualizado correctamente.');
          resolve(data);
        } else {
          reject(new Error(`Crisp respondió con código ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main(){
  if(!WEBSITE_ID || !TOKEN_ID || !TOKEN_KEY || !ARTICLE_ID){
    console.log('Faltan variables de entorno de Crisp (CRISP_WEBSITE_ID, CRISP_TOKEN_ID, CRISP_TOKEN_KEY, CRISP_ARTICLE_ID). No se sincronizó nada.');
    return;
  }
  const contenido = construirContenidoCompleto();
  await actualizarArticuloCrisp(contenido);
}

main().catch(err => {
  console.error('Error sincronizando con Crisp:', err.message);
  process.exit(1);
});
