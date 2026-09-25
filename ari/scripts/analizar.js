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
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const UMBRAL_GANGA = 0.15; // 15% por debajo del promedio = verde
const UMBRAL_SOBREVALORADA = 0.15; // 15% por encima del promedio = rojo

// Estados en los que trabaja Arenas Realty Group. Cualquier ficha que no
// caiga en uno de estos se descarta ANTES del análisis: los scrapers pueden
// traer resultados de otros estados (el buscador de Bienes Online no filtra
// por estado de verdad), y no queremos que contaminen ni el promedio ni la
// interfaz.
const ESTADOS_PERMITIDOS = ["Distrito Capital", "Miranda", "La Guaira"];

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

function extraerEstado(ubicacion) {
  // "ubicacion" viene como "Ciudad, Estado" (así la dejó el scraper). El
  // estado es lo que queda después de la última coma.
  if (!ubicacion) return null;

  // Caso especial: algunos anuncios de InmueblesConLupa solo traen el estado
  // sin ciudad ("en Distrito Capital") — sin coma. Si la ubicación completa
  // coincide con un estado permitido, es ese estado.
  const directo = ubicacion.trim().toLowerCase();
  for (const estado of ESTADOS_PERMITIDOS) {
    if (directo === estado.toLowerCase()) return estado;
  }

  if (!ubicacion.includes(",")) return null;
  const partes = ubicacion.split(",");
  return partes[partes.length - 1].trim();
}

function limpiarZona(zona) {
  // El scraper de Bienes Online a veces mete el título completo en el campo
  // de ubicación (ej. "Acogedor Apartamento en Venta San Antonio de Los
  // ALtos, Miranda" en vez de "San Antonio de Los Altos, Miranda"). Aquí se
  // recupera el área geográfica real para que el filtro de "áreas" muestre
  // solo zonas (Altamira, Los Palos Grandes, ...) y no texto de anuncio.
  if (!zona) return zona;
  let r = zona.trim();

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

  return limpia;
}

function normalizarTipo(tipo) {
  // Los anuncios de distintos estados escriben el tipo con mayúsculas
  // distintas ("CASA", "Casa", "casa") — sin esto, el promedio y los
  // filtros los tratan como categorías separadas por error.
  if (!tipo) return tipo;
  const limpio = tipo.trim().toLowerCase();
  return limpio.charAt(0).toUpperCase() + limpio.slice(1);
}

function encontrarFichasMaestrasMasReciente() {
  const archivos = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("fichas-maestras-") && f.endsWith(".json"))
    .sort(); // los nombres incluyen fecha ISO, así que ordenar alfabético = ordenar por fecha
  if (archivos.length === 0) return null;
  return archivos[archivos.length - 1];
}

function calcularPrecioM2(ficha) {
  const precio = normalizarNumero(ficha.precio_texto);
  const m2 = normalizarNumero(ficha.metros_cuadrados);
  if (!precio || !m2 || m2 <= 0) return null;
  if (precio < PRECIO_MINIMO_VALIDO || m2 < M2_MINIMO_VALIDO) return null; // dato roto, no una ganga real
  return precio / m2;
}

function claveGrupo(tipo, estado) {
  return `${tipo}||${estado}`;
}

function main() {
  const archivoReciente = encontrarFichasMaestrasMasReciente();
  if (!archivoReciente) {
    console.log("No se encontró ningún archivo fichas-maestras-*.json en ari/data/");
    return;
  }
  console.log(`Analizando ${archivoReciente}...`);

  const contenido = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivoReciente), "utf-8"));
  const fichasTodas = contenido.fichas || [];

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

  for (const ficha of fichas) {
    ficha.tipo = normalizarTipo(ficha.tipo); // corrige mayúsculas antes de agrupar y de guardar
    const precioM2 = calcularPrecioM2(ficha);
    const estado = extraerEstado(ficha.ubicacion);
    ficha._precio_m2 = precioM2;
    ficha._estado = estado;
    if (precioM2 && ficha.tipo && estado) {
      const clave = claveGrupo(ficha.tipo, estado);
      if (!precioM2PorGrupo.has(clave)) precioM2PorGrupo.set(clave, []);
      precioM2PorGrupo.get(clave).push(precioM2);
    }
  }

  // Promedio por tipo + estado.
  const promedioPorGrupo = new Map();
  for (const [clave, precios] of precioM2PorGrupo.entries()) {
    const promedio = precios.reduce((suma, p) => suma + p, 0) / precios.length;
    promedioPorGrupo.set(clave, promedio);
    console.log(`  ${clave.replace("||", " / ")}: promedio USD ${promedio.toFixed(0)}/m² (${precios.length} fichas)`);
  }

  const fichasAnalizadas = fichas.map((ficha) => {
    const zona = extraerZona(ficha.ubicacion);
    const { _precio_m2, _estado, ...resto } = ficha;
    const clave = ficha.tipo && _estado ? claveGrupo(ficha.tipo, _estado) : null;
    const promedioGrupo = clave ? promedioPorGrupo.get(clave) : null;

    if (!_precio_m2 || !promedioGrupo) {
      return { ...resto, zona, precio_m2: null, promedio_m2_tipo_zona: null, semaforo: "sin_datos_suficientes" };
    }

    const diferencia = (_precio_m2 - promedioGrupo) / promedioGrupo; // negativo = más barato que el promedio

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
      precio_m2: Math.round(_precio_m2),
      promedio_m2_tipo_zona: Math.round(promedioGrupo),
      diferencia_vs_promedio_pct: Math.round(diferencia * 100),
      semaforo,
    };
  });

  // Ordenar: primero las verdes (gangas), luego amarillas, luego rojas,
  // luego sin datos — así el asesor ve las oportunidades más interesantes
  // arriba de una vez.
  const orden = { verde: 0, amarillo: 1, rojo: 2, sin_datos_suficientes: 3 };
  fichasAnalizadas.sort((a, b) => orden[a.semaforo] - orden[b.semaforo]);

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

main();
