// ARI — Scraper de InmueblesConLupa (sitemap + title extraction)
//
// Estrategia: usa los sitemaps públicos de InmueblesConLupa para descubrir
// propiedades, filtra por estado desde la URL, y extrae datos del <title>
// de cada página individual.  Sin dependencias externas ni APIs pagas.
//
// Los sitemaps tienen ~5000 listings cada uno y se actualizan diariamente.
// El sitemap 0 tiene los más recientes; escaneamos hasta 3 sitemaps y
// limitamos a 300 páginas scrapeadas por ejecución para caber en 6h.

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const CONFIG_PATH = path.join(__dirname, "..", "config", "busquedas.json");
const DATA_DIR = path.join(__dirname, "..", "data");

const ESTADOS_PERMITIDOS = ["miranda", "distrito-capital", "la-guaira", "vargas"];
const MAX_PAGINAS = 300; // máximo de listings a scrapear por ejecución
const SITEMAPS_A_REVISAR = 3; // sitemaps 0, 1, 2 (los más recientes)

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
  "Accept-Language": "es-VE,es;q=0.9",
};

// Extrae datos del título: "Tipo en operacion en Municipio, Estado — $precio"
// Variantes: "... — $precio/mes", "... — $precio/día", "Alquiler temporal USD X/día"
function parsearTitulo(titulo) {
  const resultado = {
    titulo: titulo || "",
    tipo: null,
    operacion: null,
    municipio: null,
    estado: null,
    precio_texto: null,
    precio_usd: null,
  };

  if (!titulo) return resultado;

  // Patrón principal: "Tipo en venta/alquiler en Municipio, Estado — $precio[/mes]"
  const match = titulo.match(
    /^([A-ZÁÉÍÓÚÑ][\w\s]+?)\s+en\s+(venta|alquiler)\s+en\s+([^,—]+?),\s*(Distrito\s*Capital|Miranda|La\s*Guaira|Vargas|Caracas)\s*[—–-]?\s*\$?\s*([\d.,]+)/i
  );

  if (!match) {
    // Patrón flexible: cualquier "Tipo en operacion" sin ubicación estructurada
    const flexMatch = titulo.match(
      /^([\w\s]+?)\s+en\s+(venta|alquiler)/i
    );
    if (flexMatch) {
      resultado.tipo = capitalize(flexMatch[1].trim());
      resultado.operacion = capitalize(flexMatch[2]);
    }

    // Precio al final (puede tener "/mes", "/día", "/semana")
    const precioFlex = titulo.match(/\$?\s*([\d.,]+)\s*(?:\/mes|\/d[ií]a|\/semana)?\s*$/i);
    if (precioFlex) {
      resultado.precio_texto = "$" + precioFlex[1];
      resultado.precio_usd = parsearPrecio(precioFlex[1]);
    }
    return resultado;
  }

  resultado.tipo = capitalize(match[1].trim());
  resultado.operacion = capitalize(match[2]);
  resultado.municipio = match[3].trim();
  resultado.estado = normalizarEstado(match[4]);
  const precioRaw = match[5];
  resultado.precio_texto = "$" + precioRaw;
  resultado.precio_usd = parsearPrecio(precioRaw);

  return resultado;
}

function capitalize(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function normalizarEstado(raw) {
  const limpio = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (limpio.includes("distrito capital") || limpio.includes("caracas"))
    return "Distrito Capital";
  if (limpio.includes("guaira")) return "La Guaira";
  if (limpio.includes("vargas")) return "La Guaira";
  if (limpio.includes("miranda")) return "Miranda";
  return raw.trim();
}

function parsearPrecio(raw) {
  // "165.000", "165,000", "165000" → 165000
  const limpio = raw.replace(/\./g, "").replace(/,/g, "").trim();
  const num = parseInt(limpio, 10);
  return isNaN(num) ? null : num;
}

function extraerEstadoDeUrl(url) {
  const partes = url.split("/");
  // URL: /inmuebles/{tipo}/{operacion}/{estado}/{slug}
  // El índice del estado depende, pero siempre está después de tipo (índice 3) y operación (índice 4)
  // /inmuebles / casa / venta / miranda / slug → estado en índice 6
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i].toLowerCase();
    if (ESTADOS_PERMITIDOS.includes(p)) return p;
  }
  return null;
}

async function obtenerUrlsDeSitemaps() {
  const urls = [];

  for (let i = 0; i < SITEMAPS_A_REVISAR; i++) {
    const sitemapUrl = `https://www.inmueblesconlupa.com/sitemap-listings/${i}.xml`;
    try {
      console.log(`  Descargando sitemap ${i}...`);
      const resp = await axios.get(sitemapUrl, {
        headers: HEADERS,
        timeout: 30000,
        validateStatus: () => true,
      });
      if (resp.status !== 200) {
        console.log(`    Sitemap ${i}: HTTP ${resp.status}, saltando`);
        continue;
      }

      // Extraer <loc> tags
      const locs = [...resp.data.matchAll(/<loc>([^<]+)<\/loc>/g)];
      for (const match of locs) {
        const url = match[1];
        const estado = extraerEstadoDeUrl(url);
        if (estado) {
          urls.push({ url, estado });
        }
      }
      console.log(`    ${locs.length} URLs totales, ${urls.length} acumuladas (filtradas)`);
    } catch (err) {
      console.log(`    Sitemap ${i}: error - ${err.message}`);
    }

    // Limitar total para no saturar
    if (urls.length >= MAX_PAGINAS * 2) break;
  }

  return urls.slice(0, MAX_PAGINAS);
}

// ─── Extracción de meta description ──────────────────────────────────

function extraerDeMetaDescription(html) {
  const metaMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/);
  if (!metaMatch) return {};
  const desc = metaMatch[1];
  const datos = { descripcion: desc };

  const m2Match = desc.match(/(\d[\d.,]*)\s*m[2²]/i);
  if (m2Match) datos.metros_cuadrados = parsearNumero(m2Match[1]);

  const habMatch = desc.match(/(\d+)\s*hab/i);
  if (habMatch) datos.habitaciones = parseInt(habMatch[1], 10);

  const banosMatch = desc.match(/(\d+)\s*bañ/i);
  if (banosMatch) datos.banos = parseInt(banosMatch[1], 10);

  return datos;
}

// ─── Extracción de JSON-LD ───────────────────────────────────────────

function extraerDeJsonLD(html) {
  const match = html.match(/<script\s+type="application\/ld\+json"\s+id="property-jsonld">\s*([\s\S]*?)\s*<\/script>/);
  if (!match) return {};
  try {
    const property = JSON.parse(match[1]);
    const desc = property.description || null;
    return {
      descripcion_completa: desc,
      amenities: desc ? extraerAmenities(desc) : [],
    };
  } catch (e) {
    return {};
  }
}

function extraerAmenities(texto) {
  const amenities = [];
  if (!texto) return amenities;
  const t = texto.toLowerCase();
  if (/piscina/i.test(t)) amenities.push("piscina");
  if (/jard[ií]n/i.test(t)) amenities.push("jardín");
  if (/vigilancia|seguridad\s+24|portero/i.test(t)) amenities.push("vigilancia");
  if (/estacionamiento|puesto\s+de\s+est|maletero|garaje/i.test(t)) amenities.push("estacionamiento");
  if (/ascensor/i.test(t)) amenities.push("ascensor");
  if (/vista\s+panor[aá]mic|vista\s+al\s+[aá]vila/i.test(t)) amenities.push("vista");
  if (/terraza|balc[oó]n/i.test(t)) amenities.push("terraza");
  if (/remodelad[oa]|totalmente\s+remodelad|reci[eé]n\s+(remodelad|pintad)/i.test(t))
    amenities.push("remodelado");
  if (/gimnasio|gym/i.test(t)) amenities.push("gimnasio");
  if (/sauna|turco/i.test(t)) amenities.push("sauna");
  if (/aire\s+acondicionado/i.test(t)) amenities.push("aire_acondicionado");
  return amenities;
}

function parsearNumero(raw) {
  const limpio = raw.replace(/\./g, "").replace(/,/g, "").trim();
  const num = parseInt(limpio, 10);
  return isNaN(num) ? null : num;
}

async function scrapearPagina(url, estado) {
  try {
    const resp = await axios.get(url, {
      headers: HEADERS,
      timeout: 15000,
      validateStatus: () => true,
    });
    if (resp.status !== 200) return null;

    const html = resp.data;

    // 1. Título (como antes)
    const tituloMatch = html.match(/<title>(.*?)<\/title>/);
    if (!tituloMatch) return null;
    const datos = parsearTitulo(tituloMatch[1]);

    // 2. Meta description (NUEVO: m², hab, baños)
    const meta = extraerDeMetaDescription(html);

    // 3. JSON-LD (NUEVO: descripción completa, amenities)
    const jsonld = extraerDeJsonLD(html);

    return {
      ...datos,
      metros_cuadrados: meta.metros_cuadrados || null,
      habitaciones: meta.habitaciones || null,
      banos: meta.banos || null,
      descripcion: jsonld.descripcion_completa || meta.descripcion || null,
      amenities: jsonld.amenities || [],
      enlace: url,
      estado_url: estado,
    };
  } catch (err) {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  console.log("=== ARI — Scraper InmueblesConLupa ===\n");

  // 1. Obtener URLs de los sitemaps
  console.log("Fase 1: extrayendo URLs de sitemaps...");
  const urls = await obtenerUrlsDeSitemaps();
  console.log(`  Total URLs para scrapear: ${urls.length}\n`);

  if (urls.length === 0) {
    console.log("  ⚠️  No se encontraron propiedades en los estados objetivo.");
    return;
  }

  // 2. Scrapear cada página
  console.log(`Fase 2: scrapeando ${urls.length} páginas individuales...`);
  const anuncios = [];
  let exitos = 0, fallos = 0;
  let conM2 = 0, conHab = 0, conBanos = 0;

  for (let i = 0; i < urls.length; i++) {
    const { url, estado } = urls[i];
    const datos = await scrapearPagina(url, estado);
    
    // Pequeña pausa para no saturar el servidor (100ms entre requests)
    await new Promise(r => setTimeout(r, 100));

    if (datos && datos.titulo) {
      if (datos.metros_cuadrados) conM2++;
      if (datos.habitaciones) conHab++;
      if (datos.banos) conBanos++;

      anuncios.push({
        titulo: datos.titulo,
        enlace: url,
        precio_texto: datos.precio_texto || "",
        precio_usd: datos.precio_usd,
        habitaciones: datos.habitaciones,
        banos: datos.banos,
        metros_cuadrados: datos.metros_cuadrados,
        tipo: datos.tipo || extraerTipoDeUrl(url),
        operacion_detectada: datos.operacion || extraerOperacionDeUrl(url),
        ubicacion: datos.municipio
          ? `${datos.municipio}, ${datos.estado}`
          : datos.estado || "",
        portal: "inmueblesconlupa",
        descripcion: datos.descripcion,
        amenities: datos.amenities,
      });
      exitos++;
    } else {
      fallos++;
    }

    if ((i + 1) % 50 === 0) {
      console.log(`  Progreso: ${i + 1}/${urls.length} (${exitos} ok, ${fallos} fallos, m²=${conM2} hab=${conHab} baños=${conBanos})`);
    }
  }

  console.log(`  Final: ${exitos} éxitos, ${fallos} fallos`);
  console.log(`  Con m²: ${conM2} | Con hab: ${conHab} | Con baños: ${conBanos}\n`);

  // 3. Guardar resultado
  const zonasUnicas = [...new Set(urls.map((u) => u.estado))];
  const fecha = new Date().toISOString().slice(0, 10);

  const resultado = {
    zona: zonasUnicas.join("-"),
    portal: "inmueblesconlupa",
    operacion: "venta",
    url_busqueda: "sitemaps 0-2",
    scrapeado_en: new Date().toISOString(),
    total: anuncios.length,
    anuncios,
    diagnostico: {
      urls_encontradas: urls.length,
      paginas_scrapeadas: exitos,
      fallos,
      con_m2: conM2,
      con_hab: conHab,
      con_banos: conBanos,
    },
  };

  const rutaSalida = path.join(DATA_DIR, `inmueblesconlupa-${fecha}.json`);
  fs.writeFileSync(rutaSalida, JSON.stringify(resultado, null, 2), "utf-8");
  console.log(`  ✓ Guardado en ${rutaSalida} (${anuncios.length} propiedades)`);
}

function extraerTipoDeUrl(url) {
  // /inmuebles/{tipo}/...
  const partes = url.split("/");
  // Después de "/inmuebles/" viene el tipo
  const idx = partes.findIndex((p) => p === "inmuebles");
  if (idx >= 0 && idx + 1 < partes.length) {
    return capitalize(partes[idx + 1]);
  }
  return "";
}

function extraerOperacionDeUrl(url) {
  const partes = url.split("/");
  const idx = partes.findIndex((p) => p === "inmuebles");
  if (idx >= 0 && idx + 2 < partes.length) {
    const op = partes[idx + 2].toLowerCase();
    return op === "venta" ? "Venta" : op === "alquiler" ? "Alquiler" : "";
  }
  return "";
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});