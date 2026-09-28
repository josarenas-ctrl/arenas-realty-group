// ARI — Scraper de MercadoPiso (mercadopiso.com) — vía sitemaps + JSON-LD
//
// MercadoPiso es WordPress con el tema RTCL (Real Estate). Expone ~10k
// listings en sitemaps rtcl_listing. Cada página tiene un bloque JSON-LD
// RealEstateListing muy completo: precio, m², hab, baños, amenities,
// ubicación (addressRegion) y código MLS. Mismo patrón que ConLupa/ZonaVen.

const fs = require("fs");
const path = require("path");
const axios = require("axios");

const DATA_DIR = path.join(__dirname, "..", "data");

const ESTADOS_OBJETIVO = ["miranda", "distrito capital", "caracas", "la guaira", "vargas"];
const MAX_PAGINAS = 3000; // máx de listados a scrapear por ejecución

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept-Language": "es-VE,es;q=0.9",
};

function normalizarEstado(region) {
  if (!region) return null;
  const r = region.toLowerCase();
  if (/caracas|distrito capital/.test(r)) return "Distrito Capital";
  if (/miranda/.test(r)) return "Miranda";
  if (/guaira|vargas/.test(r)) return "La Guaira";
  return null;
}

function esEstadoObjetivo(region) {
  if (!region) return false;
  const r = region.toLowerCase();
  return ESTADOS_OBJETIVO.some((s) => r.includes(s));
}

function capitalizar(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizarTipo(tipoLd) {
  const t = (tipoLd || "").toLowerCase();
  if (/apartment|flat/.test(t)) return "Apartamento";
  if (/singlefamily|house|home|villa/.test(t)) return "Casa";
  if (/store|commercial|retail|local/.test(t)) return "Local comercial";
  if (/office/.test(t)) return "Oficina";
  if (/land|lot|terreno|plot/.test(t)) return "Terreno";
  if (/condominium|townhouse|penthouse/.test(t)) return "Casa";
  if (/room|habitacion/.test(t)) return "Habitación";
  return null;
}

// Extrae del JSON-LD RealEstateListing.
function extraerDeJsonLD(html, url) {
  const match = html.match(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
  );
  if (!match) return {};

  for (const bloque of match) {
    const dm = bloque.match(/>([\s\S]*?)<\/script>/);
    if (!dm) continue;
    try {
      const json = JSON.parse(dm[1].trim());
      const graph = (json && json["@graph"]) || [json];
      for (const item of graph) {
        if (item["@type"] !== "RealEstateListing") continue;
        const offers = item.offers || {};
        const precio = offers.price ?? null;
        const moneda = offers.priceCurrency || "USD";
        const iO = offers.itemOffered || {};
        const address = iO.address || {};
        const locality = address.addressLocality || null;
        const region = address.addressRegion || null;
        const estado = normalizarEstado(region) || normalizarEstado(locality);
        const floor = iO.floorSize ? iO.floorSize.value : null;
        const amenities = (iO.amenityFeature || [])
          .filter((a) => a && a.name)
          .map((a) => a.name.toLowerCase());

        return {
          precio_numero: precio,
          precio_texto: precio ? "$" + precio : "",
          metros_cuadrados: floor != null ? parseFloat(floor) : null,
          habitaciones: iO.numberOfRooms || null,
          banos: iO.numberOfBathroomsTotal || null,
          tipo: normalizarTipo(iO["@type"]),
          ubicacion: locality ? `${capitalizar(locality)}, ${estado || region || ""}`.trim() : (estado || region),
          estado,
          codigo: item.identifier && item.identifier.value ? item.identifier.value : null,
          descripcion: item.description || null,
          amenities,
          moneda,
          publicado: item.datePosted || null,
        };
      }
    } catch (e) {
      // ignora bloques inválidos
    }
  }
  return {};
}

async function obtenerUrlsDelSitemap() {
  const urls = [];
  let i = 1;
  while (i <= 40) {
    const sitemapUrl = `https://mercadopiso.com/rtcl_listing-sitemap${i}.xml`;
    try {
      const resp = await axios.get(sitemapUrl, { headers: HEADERS, timeout: 25000, validateStatus: () => true });
      if (resp.status !== 200) {
        console.log(`  rtcl_listing-sitemap${i}: HTTP ${resp.status}, terminamos`);
        break;
      }
      const locs = [...resp.data.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
      // Filtrar solo páginas /property/ (la primera entry suele ser la portada)
      const props = locs.filter((u) => /\/property\//.test(u));
      urls.push(...props);
      console.log(`  sitemap${i}: ${props.length} properties`);
      if (props.length === 0) break;
    } catch (err) {
      console.log(`  sitemap${i}: error ${err.message}, terminamos`);
      break;
    }
    i++;
    if (urls.length >= MAX_PAGINAS * 2) break;
  }
  return urls.slice(0, MAX_PAGINAS * 2);
}

async function scrapearPagina(url) {
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
    if (resp.status !== 200) return null;
    const html = resp.data;
    const ld = extraerDeJsonLD(html, url);
    if (!ld.precio_numero && !ld.ubicacion) return null;
    const tituloMatch = html.match(/<title>(.*?)<\/title>/);
    return {
      ...ld,
      titulo: tituloMatch ? tituloMatch[1].trim() : url,
      enlace: url,
      portal: "mercadopiso",
    };
  } catch (err) {
    return null;
  }
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log("=== ARI — Scraper MercadoPiso ===\n");
  console.log("Fase 1: extrayendo URLs de sitemaps rtcl_listing...");
  const urls = await obtenerUrlsDelSitemap();
  console.log(`  Total URLs /property/: ${urls.length}\n`);

  if (urls.length === 0) {
    console.log("  ⚠️  No se encontraron properties.");
    return;
  }

  console.log(`Fase 2: scrapeando ${urls.length} páginas individuales...`);
  const anuncios = [];
  let exitos = 0, fallos = 0, enObjetivo = 0;

  for (let i = 0; i < urls.length; i++) {
    const datos = await scrapearPagina(urls[i]);
    await new Promise((r) => setTimeout(r, 100));
    if (datos) {
      if (datos.estado && esEstadoObjetivo(datos.estado)) {
        enObjetivo++;
        anuncios.push(datos);
      }
      exitos++;
    } else {
      fallos++;
    }
    if ((i + 1) % 300 === 0)
      console.log(`  Progreso: ${i + 1}/${urls.length} (${exitos} ok, ${enObjetivo} en Miranda/DC/Guaira, ${fallos} fallos)`);
  }

  console.log(`  Final: ${exitos} totales, ${enObjetivo} en estados objetivo, ${fallos} fallos\n`);

  const fecha = new Date().toISOString().slice(0, 10);
  const resultado = {
    zona: "miranda-dc-guaira",
    portal: "mercadopiso",
    operacion: "todas",
    url_busqueda: "rtcl_listing-sitemap 1-40",
    scrapeado_en: new Date().toISOString(),
    total: anuncios.length,
    anuncios,
    diagnostico: { urls_encontradas: urls.length, exitos, en_objetivo: enObjetivo, fallos },
  };

  const ruta = path.join(DATA_DIR, `mercadopiso-${fecha}.json`);
  fs.writeFileSync(ruta, JSON.stringify(resultado, null, 2), "utf-8");
  console.log(`  ✓ Guardado en ${ruta} (${anuncios.length} propiedades objetivo)`);
}

main().catch((err) => {
  console.error("Error fatal:", err.message);
  process.exit(1);
});