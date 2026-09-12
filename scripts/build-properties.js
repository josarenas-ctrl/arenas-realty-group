const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PROP_DIR = path.join(ROOT, 'propiedades');
const SITE_URL = 'https://www.arenasrealtygroup.com';

function esc(str){
  return String(str == null ? '' : str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function waNumero(data){
  return (data.whatsapp_asesor || '584149218120').replace(/\D/g,'');
}

function formatPrecio(precio) {
  const num = parseFloat(String(precio).replace(/[^0-9]/g, ''));
  if (isNaN(num)) return esc(precio); 
  return new Intl.NumberFormat('es-ES', { 
    style: 'currency', 
    currency: 'USD', 
    minimumFractionDigits: 0 
  }).format(num);
}

function videoHTML(url){
  if(!url) return '';
  const yt = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|shorts\/|embed\/))([\w-]{11})/);
  if(yt){
    return `<div class="video-wrap"><iframe src="https://www.youtube.com/embed/${yt[1]}" allowfullscreen loading="lazy"></iframe></div>`;
  }
  return `<p><a href="${esc(url)}" target="_blank" rel="noopener" class="btn-ghost">▶ Ver video de la propiedad</a></p>`;
}

function galeriaHTML(fotos){
  if(!fotos || !fotos.length){
    return '<div class="gallery-empty"></div>';
  }
  return `<div class="gallery">${fotos.map(f => `
    <div class="gallery-item">
      <div class="g-skel"></div>
      <img src="${esc(f)}" alt="" loading="lazy" decoding="async"
           onload="this.classList.add('loaded'); var s=this.previousElementSibling; if(s) s.remove();"
           onerror="this.closest('.gallery-item').classList.add('g-error'); this.remove();">
    </div>`).join('')}</div>`;
}

function caracteristicasHTML(texto){
  if(!texto) return '';
  const items = texto.split('\n').map(s => s.trim()).filter(Boolean);
  if(!items.length) return '';
  return `<h2 class="section-title">Características</h2>
  <ul class="features">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
}

function paginaHTML(slug, d){
  const titulo = esc(d.titulo);
  const precioFormateado = formatPrecio(d.precio);
  const descripcionCorta = esc((d.descripcion || '').slice(0, 155));
  const wa = waNumero(d);
  const msg = encodeURIComponent(`Hola, me interesa la propiedad "${d.titulo}"`);
  const urlPropiedad = `${SITE_URL}/propiedades/${slug}.html`;
  const fotoOG = (d.fotos && d.fotos[0]) ? `${SITE_URL}${d.fotos[0]}` : '';
  const shareMsg = encodeURIComponent(`${d.titulo} — ${d.precio}\n${urlPropiedad}`);

  const specs = [];
  if(d.area_terreno) specs.push(`<div><strong>${esc(d.area_terreno)}</strong> m² terreno</div>`);
  if(d.area_construccion) specs.push(`<div><strong>${esc(d.area_construccion)}</strong> m² construcción</div>`);
  if(d.habitaciones) specs.push(`<div><strong>${esc(d.habitaciones)}</strong> habitaciones</div>`);
  if(d.banos) specs.push(`<div><strong>${esc(d.banos)}</strong> baños</div>`);
  if(d.estacionamientos) specs.push(`<div><strong>${esc(d.estacionamientos)}</strong> puestos</div>`);

  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${titulo} — ${esc(d.operacion)} | Arenas Realty Group</title>
<style>:root{--sand:#F6EFD9; --clay:#0B2A4A; --clay-soft:#3D6690; --terracotta:#D9A438; --teal:#17A679; --cream:#FBF9F4; --line:rgba(11,42,74,0.15);}
body{font-family:'Work Sans',sans-serif;color:var(--clay);background:var(--cream);line-height:1.6;}
.wrap{max-width:960px;margin:0 auto;padding:0 24px;}.price{font-size:1.25rem;color:var(--terracotta);font-weight:600;margin-bottom:4px;}
</style></head>
<body><header><div class="wrap"><a href="/">← Arenas Realty Group</a></div></header>
<main><div class="wrap">
  ${galeriaHTML(d.fotos)}
  <h1>${titulo}</h1>
  <div class="price">${precioFormateado}</div>
  <div class="loc">${esc(d.ubicacion)}</div>
  ${specs.length ? `<div class="specs">${specs.join('')}</div>` : ''}
  <p class="desc">${esc(d.descripcion)}</p>
  ${caracteristicasHTML(d.caracteristicas)}
  ${videoHTML(d.video_url)}
</div></main></body></html>`;
}

function tarjetaHTML(slug, d){
  const foto = (d.fotos && d.fotos[0]) ? esc(d.fotos[0]) : '';
  const precioFormateado = formatPrecio(d.precio);
  return `<a class="prop-card" href="/propiedades/${slug}.html">
    <img src="${foto}" alt="${esc(d.titulo)}">
    <h4>${esc(d.titulo)}</h4>
    <div class="price">${precioFormateado}</div>
  </a>`;
}

function emptyStateHTML(tipo){
  return `<div class="prop-empty"><h3>Sin propiedades en ${tipo}.</h3></div>`;
}

function main(){
  if(!fs.existsSync(PROP_DIR)) return;
  const archivos = fs.readdirSync(PROP_DIR).filter(f => f.endsWith('.json'));
  const venta = [];
  const alquiler = [];
  const urlsSitemap = [`${SITE_URL}/`];

  archivos.forEach(nombre => {
    const slug = nombre.replace(/\.json$/, '');
    let data = JSON.parse(fs.readFileSync(path.join(PROP_DIR, nombre), 'utf-8'));
    if(data.publicada === false) return;
    
    fs.writeFileSync(path.join(PROP_DIR, `${slug}.html`), paginaHTML(slug, data));
    const tarjeta = tarjetaHTML(slug, data);
    if((data.operacion || '').toLowerCase() === 'alquiler') alquiler.push(tarjeta);
    else venta.push(tarjeta);
  });

  const indexPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf-8');
  
  // Reemplazo básico
  html = html.replace(/<!--PROPS:VENTA:START-->[\s\S]*<!--PROPS:VENTA:END-->/, `<!--PROPS:VENTA:START-->\n${venta.join('')}\n<!--PROPS:VENTA:END-->`);
  html = html.replace(/<!--PROPS:ALQUILER:START-->[\s\S]*<!--PROPS:ALQUILER:END-->/, `<!--PROPS:ALQUILER:START-->\n${alquiler.join('')}\n<!--PROPS:ALQUILER:END-->`);
  
  fs.writeFileSync(indexPath, html);
  console.log('Generación completada.');
}

main();
