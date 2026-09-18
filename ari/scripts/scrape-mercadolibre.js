// ARI — Scraper de Mercado Libre
//
// Lee las búsquedas definidas en ari/config/busquedas.json, descarga cada
// página de resultados y guarda los anuncios en bruto (sin depurar todavía)
// en ari/data/<zona>-<portal>-<fecha>.json
//
// IMPORTANTE: los selectores CSS de abajo son la mejor aproximación a la
// estructura actual de Mercado Libre, pero no se pudieron probar contra el
// sitio en vivo al escribir este script. La primera corrida es una prueba:
// si el resultado sale vacío o incompleto, hay que revisar juntos el HTML
// real y ajustar los selectores.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const CONFIG_PATH = path.join(__dirname, "..", "config", "busquedas.json");
const DATA_DIR = path.join(__dirname, "..", "data");

async function scrapeBusqueda(busqueda) {
  const { zona, portal, operacion, url } = busqueda;

  if (!url || url.startsWith("PENDIENTE")) {
    console.log(`⚠️  Saltando "${zona}" (${portal}): falta URL real en el config`);
    return null;
  }

  console.log(`Scrapeando ${zona} / ${portal} / ${operacion}...`);

  const { data: html } = await axios.get(url, {
    headers: {
      // User-Agent de navegador real: sin esto, muchos sitios devuelven
      // una página distinta o bloquean la petición.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    },
    timeout: 20000,
  });

  const $ = cheerio.load(html);
  const anuncios = [];

  // Selector best-guess para tarjetas de resultado en Mercado Libre.
  // Ajustar aquí si la primera corrida no encuentra nada.
  $("li.ui-search-layout__item, div.ui-search-result__wrapper").each((_, el) => {
    const card = $(el);

    const titulo = card.find("a.ui-search-link, h2.ui-search-item__title").first().text().trim();
    const enlace = card.find("a.ui-search-link").first().attr("href") || "";
    const precioTexto = card.find(".andes-money-amount__fraction").first().text().trim();
    const ubicacion = card.find(".ui-search-item__location, .ui-search-item__group__element--location")
      .first()
      .text()
      .trim();
    const imagen = card.find("img").first().attr("src") || card.find("img").first().attr("data-src") || "";

    if (titulo && enlace) {
      anuncios.push({
        titulo,
        enlace,
        precio_texto: precioTexto,
        ubicacion,
        imagen,
      });
    }
  });

  console.log(`  → ${anuncios.length} anuncios encontrados`);

  return {
    zona,
    portal,
    operacion,
    url_busqueda: url,
    scrapeado_en: new Date().toISOString(),
    total: anuncios.length,
    anuncios,
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

  for (const busqueda of config.busquedas) {
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
