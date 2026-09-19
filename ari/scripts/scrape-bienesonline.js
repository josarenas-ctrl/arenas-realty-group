// ARI — Scraper de Bienes Online (bienesonline.ai)
//
// A diferencia del scraper de Mercado Libre, este sí se escribió mirando el
// HTML real que devuelve el sitio (no cargó ningún muro de bloqueo al
// probarlo), así que el parsing debería ser más confiable desde el arranque.
//
// Estrategia de extracción: en vez de depender de nombres de clases CSS
// exactos (que pueden cambiar y romper el script sin avisar), buscamos
// todos los links que apuntan a una ficha de propiedad (contienen
// "/propiedad/" en el href) y extraemos el texto del contenedor más cercano
// que tenga un precio en USD. Es más resistente a pequeños cambios de
// diseño del sitio.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const CONFIG_PATH = path.join(__dirname, "..", "config", "busquedas.json");
const DATA_DIR = path.join(__dirname, "..", "data");

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "es-VE,es;q=0.9",
};

function extraerAnunciosDePagina(html, baseUrl) {
  const $ = cheerio.load(html);
  const candidatos = new Map(); // href -> { textos: [] }

  $('a[href*="/propiedad/"]').each((_, el) => {
    const hrefRel = $(el).attr("href");
    if (!hrefRel) return;
    const href = new URL(hrefRel, baseUrl).href;
    const texto = $(el).text().trim();

    if (!candidatos.has(href)) {
      candidatos.set(href, { textos: [] });
    }
    if (texto) {
      candidatos.get(href).textos.push(texto);
    }
  });

  const anuncios = [];

  for (const [href, info] of candidatos.entries()) {
    // El título real es el texto más largo entre los links duplicados
    // (el link que envuelve la imagen normalmente no tiene texto).
    const titulo = info.textos.sort((a, b) => b.length - a.length)[0] || "";
    if (!titulo) continue;

    // Buscamos el contenedor común subiendo desde el primer <a> que
    // encontramos con este href, hasta dar con un bloque de texto que
    // tenga un precio — ahí es donde vive el resto de la info de la ficha.
    let contenedor = $(`a[href*="${href.split("/propiedad/")[1]}"]`).first();
    let textoContenedor = "";
    for (let nivel = 0; nivel < 6; nivel++) {
      contenedor = contenedor.parent();
      if (!contenedor.length) break;
      textoContenedor = contenedor.text();
      if (/USD\s*[\d.,]+/.test(textoContenedor)) break;
    }

    const precioMatch = textoContenedor.match(/USD\s*[\d.,]+/);
    const specsMatch = textoContenedor.match(
      /(\d+)\s*hab\.?\D*?(\d+)\s*baños?\D*?([\d.,]+)\s*m²/i
    );
    const tipoMatch = textoContenedor.match(
      /(Casa|Apartamento|Terreno|Local|Oficina)\s*-?\s*(Venta|Alquiler)/i
    );
    const ubicacionMatch = textoContenedor.match(
      /([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ .]+,\s*[A-ZÁÉÍÓÚÑ][A-Za-záéíóúñ]+)/
    );

    anuncios.push({
      titulo,
      enlace: href,
      precio_texto: precioMatch ? precioMatch[0] : "",
      habitaciones: specsMatch ? specsMatch[1] : null,
      banos: specsMatch ? specsMatch[2] : null,
      metros_cuadrados: specsMatch ? specsMatch[3] : null,
      tipo: tipoMatch ? tipoMatch[1] : "",
      operacion_detectada: tipoMatch ? tipoMatch[2] : "",
      ubicacion: ubicacionMatch ? ubicacionMatch[1] : "",
    });
  }

  return anuncios;
}

async function scrapeBusqueda(busqueda) {
  const { zona, portal, operacion, url, paginas } = busqueda;

  if (!url || url.startsWith("PENDIENTE")) {
    console.log(`⚠️  Saltando "${zona}" (${portal}): falta URL real en el config`);
    return null;
  }

  const maxPaginas = paginas || 3; // por defecto traemos 3 páginas (60 propiedades aprox)
  console.log(`Scrapeando ${zona} / ${portal} / ${operacion} (${maxPaginas} páginas)...`);

  const todosLosAnuncios = [];
  let ultimoStatus = null;

  for (let pagina = 1; pagina <= maxPaginas; pagina++) {
    const separador = url.includes("?") ? "&" : "?";
    const urlPagina = pagina === 1 ? url : `${url}${separador}page=${pagina}`;

    const respuesta = await axios.get(urlPagina, {
      headers: HEADERS,
      timeout: 20000,
      validateStatus: () => true,
    });
    ultimoStatus = respuesta.status;

    const anunciosPagina = extraerAnunciosDePagina(respuesta.data, urlPagina);
    console.log(`  Página ${pagina}: ${anunciosPagina.length} anuncios (HTTP ${respuesta.status})`);

    if (anunciosPagina.length === 0) {
      // No hay más resultados o algo salió mal — paramos de pedir páginas.
      break;
    }
    todosLosAnuncios.push(...anunciosPagina);
  }

  console.log(`  → ${todosLosAnuncios.length} anuncios totales encontrados`);

  return {
    zona,
    portal,
    operacion,
    url_busqueda: url,
    scrapeado_en: new Date().toISOString(),
    total: todosLosAnuncios.length,
    anuncios: todosLosAnuncios,
    diagnostico: {
      ultimo_http_status: ultimoStatus,
      paginas_pedidas: maxPaginas,
    },
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const busquedasBienesOnline = config.busquedas.filter((b) => b.portal === "bienesonline");

  for (const busqueda of busquedasBienesOnline) {
    try {
      const resultado = await scrapeBusqueda(busqueda);
      if (!resultado) continue;

      const fecha = new Date().toISOString().slice(0, 10);
      const nombreArchivo = `${busqueda.zona}-${busqueda.portal}-${fecha}.json`;
      const rutaSalida = path.join(DATA_DIR, nombreArchivo);

      fs.writeFileSync(rutaSalida, JSON.stringify(resultado, null, 2), "utf-8");
      console.log(`  ✓ Guardado en ${rutaSalida}`);
    } catch (err) {
      console.error(`  ✗ Error scrapeando ${busqueda.zona}/${busqueda.portal}:`, err.message);
    }
  }
}

main();
