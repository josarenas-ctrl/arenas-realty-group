// ARI — Scraper de ZonaVen (zonaven.com) — vía sitemaps + JSON-LD
//
// ZonaVen es un portal Next.js (SPA). No tiene paginación HTML clásica,
// así que la vía confiable es leer sus sitemap-listings (9,800+ propiedades)
// y luego extraer datos estructurados del JSON-LD de cada página individual.
// Mismo patrón que el scraper de ConLupa: sin APIs pagas, solo axios.

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const DATA_DIR = path.join(__dirname, "..", "data");

const ESTADOS_PERMITIDOS = ["miranda", "distrito-capital", "la-guaira", "vargas"];
const MAX_PAGINAS = 2500; // máx de listados a scrapear por ejecución

const SITEMAPS_LISTINGS = [
  "https://zonaven.com/sitemap-listings-1.xml",
  "https://zonaven.com/sitemap-listings-2.xml",
];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "es-VE,es;q=0.9",
};

const NOMBRES_ESTADO = {
  "distrito-capital": "Distrito Capital",
  "distrito capital": "Distrito Capital",
  caracas: "Distrito Capital",
  miranda: "Miranda",
  "la-guaira": "La Guaira",
  vargas: "La Guaira",
};

function capitalizar(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Extrae el estado desde la URL de ZonaVen: /venta/slug o /zonas/caracas
function estadoDeUrl(url) {
  const u = url.toLowerCase();
  for (const [clave, nombre] of Object.entries(NOMBRES_ESTADO)) {
    if (u.includes(`/${clave}`) || u.includes(`-${clave}`)) return nombre;
  }
  // Detectar por palabras en el slug (catia, el-hatillo, altamira...) difuso.
  return null;
}

function esEstadoObjetivo(url) {
  const u = url.toLowerCase();
  return ESTADOS_PERMITIDOS.some((s) => u.includes(s));
}

function parsearPrecio(raw) {
  if (!raw) return null;
  const limpio = raw.replace(/\./g, "").replace(/,/g, "").replace(/[^\d]/g, "");
  const n = parseInt(limpio, 10);
  return isNaN(n) ? null : n;
}

// Extrae precio, hab, baños, m² y tipo desde el JSON-LD de la página.
function normalizarTipoJsonLD(tipoLd) {
  const t = (tipoLd || "").toLowerCase();
  if (/apartment|flat/.test(t)) return "Apartamento";
  if (/singlefamily|house|home/.test(t)) return "Casa";
  if (/store|commercial|retail|local/.test(t)) return "Local comercial";
  if (/office/.test(t)) return "Oficina";
  if (/land|lot|terreno|plot/.test(t)) return "Terreno";
  if (/condominium|townhouse/.test(t)) return "Casa";
  return null;
}

function extraerDeJsonLD(html, url) {
  const match = html.match(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
  );
  if (!match) return {};

  for (const bloque of match) {
    const datosMatch = bloque.match(/>([\s\S]*?)<\/script>/);
    if (!datosMatch) continue;
    try {
      const json = JSON.parse(datosMatch[1].trim());
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        // @type puede ser string o array
        const tipos = Array.isArray(item["@type"])
          ? item["@type"]
          : [item["@type"]];
        const esInmueble = tipos.some((t) =>
          /realestate|property|offer|product/i.test(t || "")
        );
        const offers = item.offers || item.priceSpecification || {};
        const precio = offers.price ?? item.price ?? null;
        if (!esInmueble && precio == null) continue;

        const moneda = offers.priceCurrency || item.priceCurrency || "USD";

        // m² desde floorSize.value o desde la descripción
        let m2 = null;
        if (item.floorSize && item.floorSize.value != null) {
          m2 = parseFloat(String(item.floorSize.value).replace(",", "."));
        }
        const desc = (item.description || "") + " " + (item.name || "");
        if (m2 == null) {
          const m2Match = desc.match(/(\d[\d.,]*)\s*m[2²]/i);
          if (m2Match) m2 = parseFloat(m2Match[1].replace(",", "."));
        }
        const habMatch = desc.match(/(\d+)\s*hab/i);
        const banosMatch = desc.match(/(\d+)\s*bañ/i);

        // tipo: usa el segundo elemento del @type (Apartment, House, Store...)
        let tipo = null;
        for (const t of tipos) {
          const n = normalizarTipoJsonLD(t);
          if (n) { tipo = n; break; }
        }

        let operacion = url.match(/\/(venta|alquiler)\//);
        operacion = operacion ? capitalizar(operacion[1]) : null;

        return {
          precio_numero: parsearPrecio(String(precio || "")),
          precio_texto: precio ? "$" + precio : "",
          metros_cuadrados: m2,
          habitaciones: habMatch ? parseInt(habMatch[1], 10) : null,
          banos: banosMatch ? parseInt(banosMatch[1], 10) : null,
          tipo,
          operacion_detectada: operacion,
          moneda,
          descripcion: item.description || null,
        };
      }
    } catch (e) {
      // ignora bloques no-JSON
    }
  }
  return {};
}

async function obtenerUrlsDeSitemaps() {
  const urls = [];
  for (const sm of SITEMAPS_LISTINGS) {
    try {
      console.log(`  Descargando sitemap ${sm}...`);
      const resp = await axios.get(sm, { headers: HEADERS, timeout: 30000, validateStatus: () => true });
      if (resp.status !== 200) {
        console.log(`    HTTP ${resp.status}, saltando`);
        continue;
      }
      const locs = [...resp.data.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      let cnt = 0;
      for (const u of locs) {
        if (esEstadoObjetivo(u)) {
          urls.push({ url: u, estado: estadoDeUrl(u) });
          cnt++;
        }
      }
      console.log(`    ${locs.length} URLs | ${cnt} en estados objetivo`);
    } catch (err) {
      console.log(`    error: ${err.message}`);
    }
    if (urls.length >= MAX_PAGINAS) break;
  }
  return urls.slice(0, MAX_PAGINAS);
}

async function scrapearPagina(item) {
  try {
    const resp = await axios.get(item.url, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
    if (resp.status !== 200) return null;

    const html = resp.data;
    const tituloMatch = html.match(/<title>(.*?)<\/title>/);
    const ld = extraerDeJsonLD(html, item.url);

    return {
      titulo: tituloMatch ? tituloMatch[1].trim() : item.url,
      enlace: item.url,
      precio_texto: ld.precio_texto || "",
      precio_usd: ld.precio_numero,
      habitaciones: ld.habitaciones,
      banos: ld.banos,
      metros_cuadrados: ld.metros_cuadrados,
      tipo: ld.tipo || null,
      operacion_detectada: ld.operacion_detectada,
      ubicacion: extractUbicacion(item.url),
      portal: "zonaven",
      descripcion: ld.descripcion,
      moneda: ld.moneda || "USD",
    };
  } catch (err) {
    return null;
  }
}

// Intenta sacar municipio/estado de la URL; mínimo el estado.
function extractUbicacion(url) {
  const estado = estadoDeUrl(url);
  // Zonas conocidas clave de Miranda/DC para humanizar la ubicación.
  const zonas = ["el-hatillo", "baruta", "chacao", "sucre", "san-antonio-de-los-altos",
    "los-teques", "guarenas", "guatire", "altamira", "las-mercedes", "prados-del-este",
    "santa-monica", "colinas-de-be", "el-cafetal", "la-urbina"];
  const u = url.toLowerCase();
  for (const z of zonas) {
    if (u.includes(z)) {
      const nombre = z.split("-").map(capitalizar).join(" ");
      return estado ? `${nombre}, ${estado}` : nombre;
    }
  }
  return estado || "Venezuela";
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log("=== ARI — Scraper ZonaVen ===\n");
  console.log("Fase 1: extrayendo URLs de sitemaps...");
  const urls = await obtenerUrlsDeSitemaps();
  console.log(`  Total URLs objetivos: ${urls.length}\n`);

  if (urls.length === 0) {
    console.log("  ⚠️  No se encontraron propiedades en estados objetivo.");
    return;
  }

  console.log(`Fase 2: scrapeando ${urls.length} páginas individuales...`);
  const anuncios = [];
  let exitos = 0, fallos = 0, conPrecio = 0;

  for (let i = 0; i < urls.length; i++) {
    const datos = await scrapearPagina(urls[i]);
    await new Promise((r) => setTimeout(r, 100));
    if (datos) {
      if (datos.precio_usd) conPrecio++;
      anuncios.push(datos);
      exitos++;
    } else {
      fallos++;
    }
    if ((i + 1) % 200 === 0)
      console.log(`  Progreso: ${i + 1}/${urls.length} (${exitos} ok, ${fallos} fallos, precios=${conPrecio})`);
  }

  console.log(`  Final: ${exitos} éxitos, ${fallos} fallos`);
  console.log(`  Con precio: ${conPrecio}\n`);

  const fecha = new Date().toISOString().slice(0, 10);
  const resultado = {
    zona: "miranda-dc-guaira",
    portal: "zonaven",
    operacion: "todas",
    url_busqueda: "sitemap-listings-1/2",
    scrapeado_en: new Date().toISOString(),
    total: anuncios.length,
    anuncios,
    diagnostico: { urls_encontradas: urls.length, exitos, fallos, con_precio: conPrecio },
  };

  const ruta = path.join(DATA_DIR, `zonaven-${fecha}.json`);
  fs.writeFileSync(ruta, JSON.stringify(resultado, null, 2), "utf-8");
  console.log(`  ✓ Guardado en ${ruta} (${anuncios.length} propiedades)`);
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});
