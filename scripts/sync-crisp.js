const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const PROP_DIR = path.join(ROOT, 'propiedades');
const SITE_URL = 'https://www.arenasrealtygroup.com';

// Variables de entorno (se configuran como secrets en GitHub, nunca escritas aquí)
const WEBSITE_ID = process.env.CRISP_WEBSITE_ID;
const TOKEN_ID   = process.env.CRISP_TOKEN_ID;
const TOKEN_KEY  = process.env.CRISP_TOKEN_KEY;
const ARTICLE_ID = process.env.CRISP_ARTICLE_ID;
const LOCALE     = process.env.CRISP_LOCALE || 'es';

const TITULO_ARTICULO = 'Catálogo de propiedades — Arenas Realty Group';

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

// Petición genérica a la API de Crisp. Devuelve el texto de la respuesta si es 2xx.
function crispRequest(method, apiPath, bodyObj, etiqueta){
  return new Promise((resolve, reject) => {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const auth = Buffer.from(`${TOKEN_ID}:${TOKEN_KEY}`).toString('base64');

    const headers = {
      'Authorization': `Basic ${auth}`,
      'X-Crisp-Tier': 'plugin',
      'Accept': 'application/json'
    };
    if(body){
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(
      { hostname: 'api.crisp.chat', path: apiPath, method, headers },
      res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if(res.statusCode >= 200 && res.statusCode < 300){
            resolve(data);
          } else {
            reject(new Error(`Crisp respondió con código ${res.statusCode} en "${etiqueta}": ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    if(body) req.write(body);
    req.end();
  });
}

// Paso 1: convierte el ID viejo del artículo en su "tree path" (ej. catalogo/catalogo-de-propiedades.md)
async function obtenerTreePath(){
  const raw = await crispRequest(
    'GET',
    `/v1/website/${WEBSITE_ID}/helpdesk/page/entity/${LOCALE}/articles/${ARTICLE_ID}`,
    null,
    'buscar ruta del artículo'
  );
  const json = JSON.parse(raw);
  const treePath = (json.data && json.data.tree_path) || json.tree_path;
  if(!treePath){
    throw new Error(`Crisp no devolvió tree_path para el artículo. Respuesta: ${raw}`);
  }
  return treePath;
}

// Codifica cada segmento de la ruta pero conserva las barras
function codificarRuta(treePath){
  return treePath.split('/').map(encodeURIComponent).join('/');
}

// Paso 2: actualiza el contenido (cuerpo) del artículo
async function guardarContenido(treePath, contenido){
  await crispRequest(
    'PUT',
    `/v1/website/${WEBSITE_ID}/helpdesk/tree/content/${LOCALE}/articles/${codificarRuta(treePath)}`,
    { content: contenido },
    'guardar contenido'
  );
}

// Paso 3: mantiene título y estado publicado (petición aparte, según la API nueva)
async function guardarMetadata(treePath){
  await crispRequest(
    'PATCH',
    `/v1/website/${WEBSITE_ID}/helpdesk/tree/metadata/${LOCALE}/articles/${codificarRuta(treePath)}`,
    {
      format: 'articles',
      title: TITULO_ARTICULO,
      state: { published: true }
    },
    'guardar metadatos'
  );
}

async function main(){
  if(!WEBSITE_ID || !TOKEN_ID || !TOKEN_KEY || !ARTICLE_ID){
    console.log('Faltan variables de entorno de Crisp (CRISP_WEBSITE_ID, CRISP_TOKEN_ID, CRISP_TOKEN_KEY, CRISP_ARTICLE_ID). No se sincronizó nada.');
    return;
  }

  const contenido = construirContenidoCompleto();

  const treePath = await obtenerTreePath();
  console.log('Ruta del artículo en Crisp:', treePath);

  await guardarContenido(treePath, contenido);
  console.log('Contenido del artículo de Crisp actualizado correctamente.');

  // Los metadatos son secundarios: si fallan, el contenido ya quedó guardado.
  try{
    await guardarMetadata(treePath);
    console.log('Metadatos del artículo actualizados.');
  }catch(e){
    console.warn('Aviso: el contenido se guardó, pero los metadatos no se pudieron actualizar:', e.message);
  }
}

main().catch(err => {
  console.error('Error sincronizando con Crisp:', err.message);
  process.exit(1);
});
