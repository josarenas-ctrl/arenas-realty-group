// ARI — Análisis de valor y semáforo de inversión
//
// Lee ari/data/fichas-maestras-<fecha>.json (la más reciente), calcula el
// precio por m² de cada ficha, y le asigna un semáforo comparándola contra
// el promedio de propiedades del mismo tipo (Casa/Apartamento/Terreno) EN
// EL MISMO ESTADO — comparar precios de Zulia contra precios de Miranda no
// tendría sentido, los mercados son completamente distintos entre estados.
//
//   VERDE  — precio por m² al menos 15% por debajo del promedio de su
//            estado (posible ganga, vale la pena que el asesor la revise)
//   AMARILLO — dentro de +/- 15% del promedio (precio de mercado normal)
//   ROJO   — al menos 15% por encima del promedio (sobrevalorada frente
//            a comparables del mismo tipo y estado)
//
// No usa IA: el cálculo es aritmético puro sobre los datos ya depurados.
// Esto es la base; más adelante se puede sumar histórico de varias
// corridas para comparar contra tendencia en el tiempo, no solo contra el
// promedio del momento actual.
//
// Fichas sin m² (terrenos comerciales, locales sin dato, etc.), sin estado
// reconocible, o con precio/m² fuera de rango razonable (dato roto del
// anuncio original) quedan marcadas como "sin_datos_suficientes" — no se
// les asigna semáforo para no dar una señal falsa con información mala.

const fs = require("fs");
const https = require("https");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const UMBRAL_GANGA = 0.15; // 15% por debajo del promedio = verde
const UMBRAL_SOBREVALORADA = 0.15; // 15% por encima del promedio = rojo

// Estados en los que trabaja Arenas Realty Group. Cualquier ficha que no
// caiga en uno de estos se descarta ANTES del análisis: los scrapers pueden
// traer resultados de otros estados (el buscador de Bienes Online no filtra
// por estado de verdad), y no queremos que contaminen ni el promedio ni la
// interfaz.
const ESTADOS_PERMITIDOS = ["Distrito Capital", "Miranda", "Vargas"];
// Extraccion de zona por IA (Gemini) — fallback cuando limpiarZona no puede.
const ZONA_IA_CACHE = new Map();
async function extraerZonaConIA(titulo) {
  const key = titulo.toLowerCase().trim();
  if (ZONA_IA_CACHE.has(key)) return ZONA_IA_CACHE.get(key);
  if (!process.env.GEMINI_API_KEY) { ZONA_IA_CACHE.set(key, null); return null; }
  try {
    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "Dado un titulo de anuncio inmobiliario venezolano, devuelve solo el nombre de la urbanizacion o zona. Si solo menciona municipio (Sucre, Baruta, Chacao, Libertador, El Hatillo) o ciudad (Caracas), responde NINGUNA.\n\nTitulo: " + titulo }] }]
      })
    });
    const j = await resp.json();
    const raw = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text || "").trim();
    const result = (raw && raw !== "NINGUNA") ? raw : null;
    ZONA_IA_CACHE.set(key, result);
    if (result) console.log("  IA zona: " + titulo.slice(0,60) + " → " + result);
    return result;
  } catch(e) {
    ZONA_IA_CACHE.set(key, null);
    return null;
  }
}


// Filtro de sanidad: precios o metros absurdamente bajos casi siempre son
// error de carga del anuncio original (el dueño no puso el precio real,
// o el sitio no capturó bien el dato), no una ganga real. Sin esto, un
// solo anuncio roto puede arruinar el promedio de todo un estado.
const PRECIO_MINIMO_VALIDO = 500; // por debajo de esto, se descarta
const M2_MINIMO_VALIDO = 5; // menos de esto tampoco es una propiedad real

function normalizarNumero(texto) {
  if (!texto) return null;
  let limpio = String(texto).replace(/[^\d.,]/g, "");

  // Los datos de origen no son consistentes: a veces la coma es separador
  // de miles ("1,578" = mil quinientos setenta y ocho) y a veces el punto
  // lo es ("240.000" = doscientos cuarenta mil). Si hay una coma seguida
  // de exactamente 3 dígitos al final y no hay ningún punto, es separador
  // de miles — quitarla en vez de tratarla como decimal.
  if (/,\d{3}$/.test(limpio) && !limpio.includes(".")) {
    limpio = limpio.replace(/,/g, "");
  } else {
    limpio = limpio.replace(/\./g, "").replace(",", ".");
  }

  const numero = parseFloat(limpio);
  return isNaN(numero) ? null : numero;
}

// Resolución geográfica vía OpenStreetMap Nominatim (gratuito, sin API key,
// datos auditables). Cada ciudad/zona se consulta una sola vez y se cachea en
// memoria durante la corrida. Si Nominatim no responde, la zona queda sin
// estado corregido — el sistema sigue funcionando con el estado que declaró el
// anuncio.

const cacheNominatim = new Map(); // zona_lower → "Miranda" | null

function resolverEstadoNominatim(zona) {
  if (!zona || zona.length < 3) return Promise.resolve(null);
  const key = zona.toLowerCase().trim();
  if (cacheNominatim.has(key)) return Promise.resolve(cacheNominatim.get(key));

  return new Promise((resolve) => {
    const query = encodeURIComponent(`${zona}, Venezuela`);
    const opts = {
      headers: { "User-Agent": "ARI/1.0 (arenasrealtygroup.com)" },
      timeout: 5000,
    };

    https.get(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1&addressdetails=1`, opts, (res) => {
      let data = "";
      res.on("data", (chunk) => data += chunk);
      res.on("end", () => {
        try {
          const results = JSON.parse(data);
          if (!Array.isArray(results) || results.length === 0) {
            cacheNominatim.set(key, null);
            return resolve(null);
          }
          const stateRaw = results[0].address?.state || "";
          const normalizado = stateRaw.replace(/^Estado\s+/i, "").trim();
          const match = ESTADOS_PERMITIDOS.find((e) => e.toLowerCase() === normalizado.toLowerCase());
          cacheNominatim.set(key, match || null);
          resolve(match || null);
        } catch {
          cacheNominatim.set(key, null);
          resolve(null);
        }
      });
    }).on("error", () => {
      cacheNominatim.set(key, null);
      resolve(null);
    }).on("timeout", function () {
      this.destroy();
      cacheNominatim.set(key, null);
      resolve(null);
    });
  });
}

// Versión síncrona para usar dentro del pipeline de análisis (después de que
// el caché ya está poblado en la fase inicial).
function estadoDesdeCache(zona) {
  if (!zona) return null;
  return cacheNominatim.get(zona.toLowerCase().trim()) ?? null;
}

function extraerEstado(ubicacion) {
  // "ubicacion" viene como "Ciudad, Estado" (así la dejó el scraper). El
  // estado es lo que queda después de la última coma.
  if (!ubicacion) return null;

  const ubicacionLower = ubicacion.trim().toLowerCase();

    // Corrección por ciudad: si la ZONA (todo antes de la última coma)
    // es o empieza con una ciudad de ubicación conocida, forzar el estado
    // correcto. Así evitamos falsos positivos cuando la descripción dice
    // "cerca de Los Teques" pero la propiedad está en otro lado.
    const partesUbicacion = ubicacion.includes(",") ? ubicacion.split(",") : [ubicacion];
    const zonaRaw = (partesUbicacion.length > 1
      ? partesUbicacion.slice(0, -1).join(",").trim().toLowerCase()
      : partesUbicacion[0].trim().toLowerCase());

    // Caso especial: algunos anuncios de InmueblesConLupa solo traen el estado
    // sin ciudad ("en Distrito Capital") — sin coma. Si la ubicación completa
    // coincide con un estado permitido, es ese estado.
    for (const estado of ESTADOS_PERMITIDOS) {
      if (ubicacionLower === estado.toLowerCase()) return estado;
    }

    if (!ubicacion.includes(",")) return null;
    const estadoRaw = partesUbicacion[partesUbicacion.length - 1].trim();

    // Verificación final: si el estado extraído es uno de los permitidos,
    // usarlo directamente. La ubicacion del anuncio es más fiable que
    // Nominatim (que busca por nombre de zona sin coordenadas).
    if (ESTADOS_PERMITIDOS.includes(estadoRaw)) {
      // CORRECCIÓN: Bienes Online pone "Distrito Capital" por defecto cuando
      // no conoce el estado real. Si el anuncio declara DC pero la ciudad es
      // conocida por Nominatim como de Miranda/Vargas, corregir al estado real.
      if (estadoRaw === "Distrito Capital") {
        const ciudadParaVerificar = zonaRaw.split(/[,—–-]/)[0].trim();
        const estadoReal = estadoDesdeCache(ciudadParaVerificar);
        if (estadoReal && estadoReal !== "Distrito Capital") return estadoReal;
      }
      return estadoRaw;
    }

    // Solo si la ubicacion no da un estado válido, consultar Nominatim.
    const ciudadPrincipal = zonaRaw.split(/[,—–-]/)[0].trim();
    const estadoCorregido = estadoDesdeCache(ciudadPrincipal);
    if (estadoCorregido) return estadoCorregido;

        const cp = zonaRaw.split(/[,—–-]/)[0].trim();
        const ec = estadoDesdeCache(cp);
        if (ec) return ec;

        return null;
          }

        function extraerMunicipio(ubicacion) {
          // Extrae el municipio/ciudad: la parte antes de la última coma.
          // "Altamira, Distrito Capital" → "Altamira"
          // "San Antonio de Los Altos, Miranda" → "San Antonio de Los Altos"
          if (!ubicacion || !ubicacion.includes(",")) return null;
          const raw = ubicacion.split(",")[0].trim();
          return limpiarMunicipio(raw);
        }

        function limpiarMunicipio(municipio) {
          if (!municipio) return null;
          let r = municipio.trim();

          // El scraper de Bienes Online a veces mete el título completo en
          // ubicación ("Acogedor Apartamento en Venta San Antonio de Los
          // ALtos, Miranda"). Si empieza con palabra de título, el municipio
          // real es lo que viene DESPUÉS de "en venta/alquiler/arriendo".
          if (/^(acogedor|bello|bella|hermos[oa]|ampli[oa]|c[oó]mod[oa]|excelente|espectacular|extraordinari[oa]|lind[oa]|bonit[oa]|espl[eé]ndid[oa]|d[uú]plex|venta|alquiler|arriendo)/i.test(r)) {
            const op = r.match(/\b(?:en\s+)?(venta|alquiler|arriendo|arrendamiento)\b/i);
            if (op) {
              const despues = r.slice(op.index + op[0].length).replace(/^[:\s—-]+/, "").trim();
              if (despues) r = despues;
            } else {
              return null; // título sin ubicación reconocible
            }
          }

          // Inglés → español
          if (/^capital district$/i.test(r)) r = "Distrito Capital";

          // Mayúsculas rotas ("ALtos")
          r = r.replace(/\bALtos\b/g, "Altos");

          return r.trim();
        }

        function limpiarZona(zona) {
  if (!zona) return null;

  // El scraper de Bienes Online a veces mete el título completo en el campo
  // de ubicación (ej. "Acogedor Apartamento en Venta San Antonio de Los
  // ALtos, Miranda" en vez de "San Antonio de Los Altos, Miranda"). Aquí se
  // recupera el área geográfica real para que el filtro de "áreas" muestre
  // solo zonas (Altamira, Los Palos Grandes, ...) y no texto de anuncio.
  let r = zona.trim();

  // 1) Si empieza con palabra de título genérica, es un título mal guardado,
  //    no una zona real ("Acogedor Apartamento en Venta San Antonio...").
  if (/^(acogedor|bello|bella|hermos[oa]|ampli[oa]|cómod[oa]|excelente|espectacular|extraordinari[oa]|lind[oa]|bonit[oa]|espl[eé]ndid[oa]|venta|alquiler)/i.test(r)) return null;

  // 1) Título filtrado: si aparece "en venta/alquiler/arriendo", el área
  //    real es lo que viene DESPUÉS de esa frase.
  const op = r.match(/\b(?:en\s+)?(venta|alquiler|arriendo|arrendamiento)\b/i);
  if (op) {
    const despues = r.slice(op.index + op[0].length).replace(/^[:\s—-]+/, "").trim();
    if (despues) r = despues;
  }

  // 2) "Poblacion de San José de los Altos" → "San José de los Altos".
  r = r.replace(/^poblaci[oó]n\s+de\s+/i, "");

  // 3) Inglés (a veces el sitio escribe "Capital District").
  if (/^capital district$/i.test(r)) r = "Distrito Capital";

  // 4) Mayúsculas rotas ("ALtos") para que la misma zona no salga dos veces.
  r = r.replace(/\bALtos\b/g, "Altos");

  // 5) "Rosalito San Antonio de Los Altos" / "Altos de la Peña San Antonio de
  //    los Altos" → quedarse con el área principal, no la urbanización interna.
  if (/(San Antonio de Los Altos)$/i.test(r)) r = "San Antonio de Los Altos";

  return r.trim();
}

function extraerZona(ubicacion) {
  // El área es todo lo que va antes de la última coma (el estado).
  if (!ubicacion) return null;
  const partes = ubicacion.split(",");
  const zona = partes.length > 1
    ? partes.slice(0, -1).join(",").trim()
    : partes[0].trim(); // sin coma: solo estado o zona suelta
  const limpia = limpiarZona(zona);
  if (!limpia) return null;

  // Un estado no es un área: "Miranda, Distrito Capital" tiene el estado
  // invertido, y "Capital District" es un estado escrito en inglés.
  const esEstado = ESTADOS_PERMITIDOS.some((e) => e.toLowerCase() === limpia.toLowerCase());
  if (esEstado) return null;

  // Basura como "La N" (artículo + una letra) no es una zona.
    if (/^la\s+[a-zñ]$/i.test(limpia)) return null;

    // Municipios, ciudades satélite, playas y parroquias NO son áreas
    // geográficas de urbanización. El usuario solo quiere Altamira,
    // Los Palos Grandes, Las Mercedes y equivalentes.
    const NO_ES_AREA = new Set([
      // municipios del área metropolitana
      "baruta","chacao","el hatillo","sucre","libertador",
      // municipios del interior
      "zamora","páez","guaicaipuro","urdaneta","vargas","independencia","plaza",
      // ciudades satélite (no son urbanizaciones de Caracas)
      "caracas","guarenas","guatire","charallave","carrizal","maiquetía",
      // parroquias y sectores genéricos
      "catia","mariche","gavilán","horizonte","la sabana","la peña",
      // playas / costa
      "agua sal","palm beach","higuerote","tanaguarena","mampote",
    ]);
    if (NO_ES_AREA.has(limpia.toLowerCase())) return null;

    return limpia;
}

function normalizarTipo(tipo, titulo) {
  // Los anuncios de distintos estados escriben el tipo con mayúsculas
  // distintas ("CASA", "Casa", "casa") — sin esto, el promedio y los
  // filtros los tratan como categorías separadas por error.
  if (tipo) {
    const limpio = tipo.trim().toLowerCase();
    // Fusionar "local" → "local comercial" (son lo mismo)
    if (limpio === 'local') return 'Local comercial';
    return limpio.charAt(0).toUpperCase() + limpio.slice(1);
  }

  // Si no hay tipo, deducir del título
  if (!titulo) return tipo;
  const t = titulo.toLowerCase();
  if (/galp[oó]n|galpon/i.test(t)) return 'Galpón';
  if (/edificio/i.test(t)) return 'Edificio';
  if (/anexo|vacacional/i.test(t)) return 'Anexo';
  if (/habitacion/i.test(t)) return 'Habitación';
  if (/local comercial|local/i.test(t)) return 'Local comercial';
  if (/oficina/i.test(t)) return 'Oficina';
  if (/terreno|lote/i.test(t)) return 'Terreno';
  if (/casa/i.test(t)) return 'Casa';
  if (/apartamento|apto|apto/i.test(t)) return 'Apartamento';
  if (/townhouse/i.test(t)) return 'Townhouse';
  if (/penthouse|pent-house/i.test(t)) return 'Penthouse';
  return null;
}

// Factor de ajuste por condición: una propiedad "por remodelar" barata no
// es ganga (es lo esperado), y una "impecable" cara no está sobrevalorada
// (es premium). Esto ajusta el precio/m² antes de comparar contra el
// promedio para que el semáforo refleje el valor real.
const FACTOR_CONDICION = { impecable: 1.15, estandar: 1.0, por_remodelar: 0.80 };

function extraerCondicion(ficha) {
  // 1) Si el scraper ya trajo condicion, usarla
  if (ficha.condicion && FACTOR_CONDICION[ficha.condicion]) return ficha.condicion;

  // 2) Extraer del título
  const titulo = (ficha.titulo || "").toLowerCase();
  if (/remodelad[oa]|totalmente\s+remodelad|reci[eé]n\s+(remodelad|pintad)|impecable|como\snuev[oa]|listo\s+para\s+habitar|estreno/i.test(titulo))
    return "impecable";
  if (/por\s+remodelar|reparaci[oó]n|necesita\s+(trabajo|arreglo)|oportunidad\s+de\s+(remodelar|inversi[oó]n)/i.test(titulo))
    return "por_remodelar";

  // 3) Extraer de la descripción (si existe)
  const desc = (ficha.descripcion || "").toLowerCase();
  if (/remodelad[oa]|totalmente\s+remodelad|reci[eé]n\s+(remodelad|pintad)|impecable|como\snuev[oa]|listo\s+para\s+habitar|estreno/i.test(desc))
    return "impecable";
  if (/por\s+remodelar|reparaci[oó]n|necesita\s+(trabajo|arreglo)|oportunidad\s+de\s+(remodelar|inversi[oó]n)/i.test(desc))
    return "por_remodelar";

  return "estandar";
}

function encontrarFichasMaestrasMasReciente() {
  const archivos = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("fichas-maestras-") && f.endsWith(".json"))
    .sort(); // los nombres incluyen fecha ISO, así que ordenar alfabético = ordenar por fecha
  if (archivos.length === 0) return null;
  return archivos[archivos.length - 1];
}

function extraerContacto(ficha) {
  const texto = `${ficha.titulo || ""} ${ficha.descripcion || ""}`.toLowerCase();

  // Teléfonos venezolanos: 0412/0414/0416/0424/0426 + 7 dígitos, o 0212/0241/etc + 7 dígitos
  const telMatch = texto.match(/0(4(12|14|16|24|26)\d{7}|212\d{7}|2(41|43|44|45|46|51|52|61|62|63|64|65|81|82|83|84|85|91|92|93|94|95)\d{7})/);
  const telefono = telMatch ? telMatch[0] : null;

  // Email
  const emailMatch = texto.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;

  return { telefono, email };
}

function calcularPrecioM2(ficha) {
  const precio = normalizarNumero(ficha.precio_texto);
  const m2 = normalizarNumero(ficha.metros_cuadrados);
  if (!precio || !m2 || m2 <= 0) return null;
  if (precio < PRECIO_MINIMO_VALIDO || m2 < M2_MINIMO_VALIDO) return null; // dato roto, no una ganga real
  return precio / m2;
}

function extraerOperacion(ficha) {
  // El scraper de ConLupa ya guarda 'operacion' ("venta"/"alquiler").
  if (ficha.operacion) return ficha.operacion.charAt(0).toUpperCase() + ficha.operacion.slice(1).toLowerCase();

  // Fallback: deducir del título.
  const titulo = (ficha.titulo || "").toLowerCase();
  if (/\balquiler\b|\balquila\b|\barriendo\b|\barrendamiento\b/i.test(titulo)) return "Alquiler";
  if (/\bventa\b|\bvendo\b/i.test(titulo)) return "Venta";

  // Fallback: deducir del precio. Ventas ≥ $10K, alquileres menos.
  const precio = normalizarNumero(ficha.precio_texto);
  if (precio && precio >= 10000) return "Venta";
  if (precio && precio > 0) return "Alquiler";

  return null;
}

function claveGrupo(tipo, estado, operacion) {
  return `${tipo}||${estado}||${operacion || "Venta"}`;
}

async function main() {
  const archivoReciente = encontrarFichasMaestrasMasReciente();
  if (!archivoReciente) {
    console.log("No se encontró ningún archivo fichas-maestras-*.json en ari/data/");
    return;
  }
  console.log(`Analizando ${archivoReciente}...`);

  const contenido = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivoReciente), "utf-8"));
  const fichasTodas = contenido.fichas || [];

  // Pre-poblar caché geográfico: extraer la ciudad principal de cada
  // ubicación y consultar Nominatim UNA sola vez por ciudad. Así las
  // llamadas síncronas a extraerEstado() siempre encuentran la respuesta
  // en memoria, sin bloquear el pipeline.
  const zonasUnicas = new Set();
  for (const ficha of fichasTodas) {
    if (!ficha.ubicacion) continue;
    const p = ficha.ubicacion.includes(",") ? ficha.ubicacion.split(",") : [ficha.ubicacion];
    const zonaRaw = (p.length > 1 ? p.slice(0, -1).join(",").trim() : p[0].trim()).toLowerCase();
    const ciudad = zonaRaw.split(/[,—–-]/)[0].trim();
    if (ciudad && ciudad.length >= 3) zonasUnicas.add(ciudad);
  }
  console.log(`  Resolviendo ${zonasUnicas.size} ciudades vía Nominatim...`);
  await Promise.all([...zonasUnicas].map(resolverEstadoNominatim));
  console.log(`  Caché geográfico listo (${cacheNominatim.size} entradas)`);

  // Filtro de estados: solo Miranda, Distrito Capital y La Guaira. Los
  // scrapers pueden traer propiedades de otros estados (Bienes Online no
  // filtra bien su buscador), así que aquí se descartan antes de calcular
  // promedios o de mostrarlas.
  const fichas = fichasTodas.filter((ficha) => {
    const estado = extraerEstado(ficha.ubicacion);
    return ESTADOS_PERMITIDOS.includes(estado);
  });
  const descartadas = fichasTodas.length - fichas.length;
  console.log(`  ${fichasTodas.length} fichas totales → ${fichas.length} en estados permitidos (${descartadas} descartadas)`);

  // Precio por m² de cada ficha, agrupado por tipo de propiedad + estado.
    const precioM2PorGrupo = new Map(); // "tipo||estado" -> [precios_m2...]
    const m2PorGrupo = new Map();        // "tipo||estado" -> [m2...] para estimar los que no tienen

    // IA zona: recolectar titulos sin zona y clasificar en lote
    const titulosSinZona = [...new Set(fichas.filter(f => !f.zona && f.titulo).map(f => f.titulo))];
    const zonaCache = new Map();
    console.log(`  Consultando IA para ${titulosSinZona.length} titulos sin zona...`);
    let iaLlamadas = 0;
    for (const titulo of titulosSinZona) {
      const z = await extraerZonaConIA(titulo);
      if (z) zonaCache.set(titulo, z);
      iaLlamadas++;
      if (iaLlamadas % 15 === 0) {
        console.log(`  IA: ${iaLlamadas}/${titulosSinZona.length} procesados, pausa anti rate-limit...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    for (const ficha of fichas) {
      if (!ficha.zona && ficha.titulo && zonaCache.has(ficha.titulo)) {
        ficha.zona = zonaCache.get(ficha.titulo);
      }

      ficha.tipo = normalizarTipo(ficha.tipo, ficha.titulo); // corrige mayúsculas antes de agrupar y de guardar
      const precioM2 = calcularPrecioM2(ficha);
      const estado = extraerEstado(ficha.ubicacion);
            const municipio = extraerMunicipio(ficha.ubicacion);
            ficha._precio_m2 = precioM2;
                ficha._estado = estado;
                ficha._municipio = municipio;
          const operacion = extraerOperacion(ficha);
          ficha.operacion = operacion; // GUARDAR operación en la ficha (antes solo se usaba para agrupar)
          if (precioM2 && ficha.tipo && estado) {
            const clave = claveGrupo(ficha.tipo, estado, operacion);
        if (!precioM2PorGrupo.has(clave)) precioM2PorGrupo.set(clave, []);
        precioM2PorGrupo.get(clave).push(precioM2);
      }
      // Acumular m² reales para poder estimar los que no lo tienen
      const m2Raw = normalizarNumero(ficha.metros_cuadrados);
            if (m2Raw && m2Raw >= M2_MINIMO_VALIDO && ficha.tipo && estado) {
              const clave = claveGrupo(ficha.tipo, estado, operacion);
        if (!m2PorGrupo.has(clave)) m2PorGrupo.set(clave, []);
        m2PorGrupo.get(clave).push(m2Raw);
      }
    }

    // Promedio por tipo + estado.
    const promedioPorGrupo = new Map();
    for (const [clave, precios] of precioM2PorGrupo.entries()) {
      const promedio = precios.reduce((suma, p) => suma + p, 0) / precios.length;
      promedioPorGrupo.set(clave, promedio);
      console.log(`  ${clave.replace("||", " / ")}: promedio USD ${promedio.toFixed(0)}/m² (${precios.length} fichas)`);
    }

    // Promedio de m² por tipo + estado (para estimar propiedades sin el dato).
    const m2PromedioPorGrupo = new Map();
    for (const [clave, m2s] of m2PorGrupo.entries()) {
      m2PromedioPorGrupo.set(clave, m2s.reduce((s, v) => s + v, 0) / m2s.length);
    }

  const fichasAnalizadas = fichas.map((ficha) => {
      const zona = ficha.zona || extraerZona(ficha.ubicacion);
            const condicion = extraerCondicion(ficha);
            const contacto = extraerContacto(ficha);
            const { _precio_m2, _estado, ...resto } = ficha;
      const clave = ficha.tipo && _estado
              ? claveGrupo(ficha.tipo, _estado, extraerOperacion(ficha))
              : null;
      const promedioGrupo = clave ? promedioPorGrupo.get(clave) : null;

      if (!_precio_m2 || !promedioGrupo) {
              // Intentar estimar con el promedio de m² del grupo. El umbral
              // mínimo de precio depende de si es venta o alquiler: las ventas
              // empiezan en ~$10K, los alquileres en ~$200/mes.
              const precio = normalizarNumero(ficha.precio_texto);
              const op = extraerOperacion(ficha);
              const precioMinimo = op === "Alquiler" ? PRECIO_MINIMO_VALIDO : 10000;
              const m2Promedio = clave ? m2PromedioPorGrupo.get(clave) : null;
              if (precio && precio >= precioMinimo && m2Promedio && promedioGrupo) {
                const precioM2Estimado = precio / m2Promedio;
                const factor = FACTOR_CONDICION[condicion] || 1.0;
                const precioAjustado = precioM2Estimado / factor;
                const diferencia = (precioAjustado - promedioGrupo) / promedioGrupo;
                let semaforo;
                if (diferencia <= -UMBRAL_GANGA) semaforo = "verde";
                else if (diferencia >= UMBRAL_SOBREVALORADA) semaforo = "rojo";
                else semaforo = "amarillo";
                return {
                                  ...resto, zona, condicion, contacto, _estado,
                                  precio_m2: Math.round(precioM2Estimado),
                  promedio_m2_tipo_zona: Math.round(promedioGrupo),
                  diferencia_vs_promedio_pct: Math.round(diferencia * 100),
                  semaforo,
                  m2_estimado: true,
                  m2_estimado_base: Math.round(m2Promedio),
                };
              }
              return { ...resto, _estado, zona, condicion, contacto, precio_m2: null, promedio_m2_tipo_zona: null, semaforo: "sin_datos_suficientes" };
            }

      // Ajustar precio/m² según condición antes de comparar contra el promedio.
      // Una propiedad "por remodelar" barata no es ganga (es lo esperado), y
      // una "impecable" cara no está sobrevalorada (es premium).
      const factor = FACTOR_CONDICION[condicion] || 1.0;
      const precioAjustado = _precio_m2 / factor;
      const diferencia = (precioAjustado - promedioGrupo) / promedioGrupo; // negativo = más barato que el promedio ajustado

    let semaforo;
    if (diferencia <= -UMBRAL_GANGA) {
      semaforo = "verde";
    } else if (diferencia >= UMBRAL_SOBREVALORADA) {
      semaforo = "rojo";
    } else {
      semaforo = "amarillo";
    }

    return {
              ...resto,
              zona,
              condicion,
              contacto,
              _estado,
              precio_m2: Math.round(_precio_m2),
          promedio_m2_tipo_zona: Math.round(promedioGrupo),
          diferencia_vs_promedio_pct: Math.round(diferencia * 100),
          semaforo,
        };
  });

  // Ordenar: primero las verdes (gangas), luego amarillas, luego rojas,
    // luego sin datos. Dentro de cada grupo, menor precio primero — el
    // asesor ve la mejor oportunidad arriba de todo.
    const orden = { verde: 0, amarillo: 1, rojo: 2, sin_datos_suficientes: 3 };
    fichasAnalizadas.sort((a, b) => {
      const ordenSemaforo = orden[a.semaforo] - orden[b.semaforo];
      if (ordenSemaforo !== 0) return ordenSemaforo;
      const precioA = normalizarNumero(a.precio_texto) || Infinity;
      const precioB = normalizarNumero(b.precio_texto) || Infinity;
      return precioA - precioB;
    });

  const conteo = fichasAnalizadas.reduce((acc, f) => {
    acc[f.semaforo] = (acc[f.semaforo] || 0) + 1;
    return acc;
  }, {});
  console.log(`Resultado: ${JSON.stringify(conteo)}`);

  const nombreSalida = archivoReciente.replace("fichas-maestras-", "analisis-");
  const rutaSalida = path.join(DATA_DIR, nombreSalida);
  const cuerpo = JSON.stringify(
    {
      generado_en: new Date().toISOString(),
      basado_en: archivoReciente,
      promedios_m2_por_tipo_y_estado: Object.fromEntries(
        [...promedioPorGrupo.entries()].map(([clave, valor]) => [clave.replace("||", " / "), Math.round(valor)])
      ),
      resumen: conteo,
      fichas: fichasAnalizadas,
    },
    null,
    2
  );

  fs.writeFileSync(rutaSalida, cuerpo, "utf-8");
  console.log(`✓ Guardado en ${rutaSalida}`);

  // Copia con nombre fijo (sin fecha) para que la interfaz de los asesores
  // siempre sepa qué archivo pedir, sin tener que adivinar la fecha de hoy.
  const rutaUltimo = path.join(DATA_DIR, "ultimo-analisis.json");
  fs.writeFileSync(rutaUltimo, cuerpo, "utf-8");
  console.log(`✓ Copia actualizada en ${rutaUltimo}`);
}

main().catch((err) => { console.error("Error en análisis:", err); process.exit(1); });
