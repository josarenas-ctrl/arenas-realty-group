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
//
// DIAGNÓSTICO: si "total" sale en 0, revisar el campo "diagnostico" del
// resultado — trae el <title> de la página recibida y si el HTML contiene
// palabras típicas de un muro de bloqueo/verificación. Eso dice si el
// problema es que Mercado Libre bloqueó la petición, o que los selectores
// no coinciden con la estructura real de la página.
//
// ESTADO CONOCIDO (confirmado): Mercado Libre bloquea las peticiones que
// vienen desde servidores de GitHub Actions (devuelve una página de
// "tráfico sospechoso" con HTTP 200, sin error visible). Este scraper se
// deja corriendo para detectar si eso cambia en el futuro, pero mientras
// tanto es normal que "total" salga en 0.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");

const CONFIG_PATH = path.join(__dirname, "..", "config", "busquedas.json");
const DATA_DIR = path.join(__dirname, "..", "data");

const PALABRAS_DE_BLOQUEO = [
  "captcha",
  "robot",
  "verifica que no eres",
  "acceso denegado",
  "unusual traffic",
  "blocked",
  "suspicious-traffic",
];

async function scrapeBusqueda(busqueda) {
  const { zona, portal, operacion, url } = busqueda;

  if (!url || url.startsWith("PENDIENTE")) {
    console.log(`⚠️  Saltando "${zona}" (${portal}): falta URL real en el config`);
    return null;
  }

  console.log(`Scrapeando ${zona} / ${portal} / ${operacion}...`);

  const respuesta = await axios.get(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "es-VE,es;q=0.9",
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  const html = respuesta.data;
  const $ = cheerio.load(html);
  const anuncios = [];

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
      anuncios.push({ titulo, enlace, precio_texto: precioTexto, ubicacion, imagen });
    }
  });

  console.log(`  → ${anuncios.length} anuncios encontrados (HTTP ${respuesta.status})`);

  const tituloPagina = $("title").text().trim();
  const htmlMinuscula = html.toLowerCase();
  const posibleBloqueo = PALABRAS_DE_BLOQUEO.some((palabra) => htmlMinuscula.includes(palabra));

  if (anuncios.length === 0) {
    console.log(`  ⚠️  0 anuncios. Título de la página recibida: "${tituloPagina}"`);
    console.log(`  ⚠️  ¿Parece un bloqueo/verificación?: ${posibleBloqueo ? "SÍ" : "no detectado"}`);
  }

  return {
    zona,
    portal,
    operacion,
    url_busqueda: url,
    scrapeado_en: new Date().toISOString(),
    total: anuncios.length,
    anuncios,
    diagnostico: {
      http_status: respuesta.status,
      titulo_pagina_recibida: tituloPagina,
      posible_bloqueo: posibleBloqueo,
      html_length: html.length,
      html_muestra: html.slice(0, 1500),
    },
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  const busquedasMercadoLibre = config.busquedas.filter((b) => b.portal === "mercadolibre");

  for (const busqueda of busquedasMercadoLibre) {
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
