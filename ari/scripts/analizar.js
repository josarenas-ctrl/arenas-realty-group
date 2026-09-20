// ARI — Análisis de valor y semáforo de inversión
//
// Lee ari/data/fichas-maestras-<fecha>.json (la más reciente), calcula el
// precio por m² de cada ficha, y le asigna un semáforo comparándola contra
// el promedio de propiedades del mismo tipo (Casa/Apartamento/Terreno) en
// la misma zona:
//
//   VERDE  — precio por m² al menos 15% por debajo del promedio (posible
//            ganga, vale la pena que el asesor la revise primero)
//   AMARILLO — dentro de +/- 15% del promedio (precio de mercado normal)
//   ROJO   — al menos 15% por encima del promedio (sobrevalorada frente
//            a comparables de la misma zona y tipo)
//
// No usa IA: el cálculo es aritmético puro sobre los datos ya depurados.
// Esto es la base; más adelante se puede sumar histórico de varias
// corridas para comparar contra tendencia en el tiempo, no solo contra el
// promedio del momento actual.
//
// Fichas sin m² (terrenos comerciales, locales sin dato, etc.) quedan
// marcadas como "sin_datos_suficientes" — no se les asigna semáforo para
// no dar una señal falsa con información incompleta.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const UMBRAL_GANGA = 0.15; // 15% por debajo del promedio = verde
const UMBRAL_SOBREVALORADA = 0.15; // 15% por encima del promedio = rojo

function normalizarNumero(texto) {
  if (!texto) return null;
  const limpio = String(texto).replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".");
  const numero = parseFloat(limpio);
  return isNaN(numero) ? null : numero;
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
  return precio / m2;
}

function main() {
  const archivoReciente = encontrarFichasMaestrasMasReciente();
  if (!archivoReciente) {
    console.log("No se encontró ningún archivo fichas-maestras-*.json en ari/data/");
    return;
  }
  console.log(`Analizando ${archivoReciente}...`);

  const contenido = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivoReciente), "utf-8"));
  const fichas = contenido.fichas || [];

  // Precio por m² de cada ficha, agrupado por tipo de propiedad.
  const precioM2PorTipo = new Map(); // tipo -> [precios_m2...]

  for (const ficha of fichas) {
    const precioM2 = calcularPrecioM2(ficha);
    ficha._precio_m2 = precioM2;
    if (precioM2 && ficha.tipo) {
      if (!precioM2PorTipo.has(ficha.tipo)) precioM2PorTipo.set(ficha.tipo, []);
      precioM2PorTipo.get(ficha.tipo).push(precioM2);
    }
  }

  // Promedio por tipo.
  const promedioPorTipo = new Map();
  for (const [tipo, precios] of precioM2PorTipo.entries()) {
    const promedio = precios.reduce((suma, p) => suma + p, 0) / precios.length;
    promedioPorTipo.set(tipo, promedio);
    console.log(`  ${tipo}: promedio USD ${promedio.toFixed(0)}/m² (${precios.length} fichas con dato)`);
  }

  const fichasAnalizadas = fichas.map((ficha) => {
    const { _precio_m2, ...resto } = ficha;
    const promedioTipo = ficha.tipo ? promedioPorTipo.get(ficha.tipo) : null;

    if (!_precio_m2 || !promedioTipo) {
      return { ...resto, precio_m2: null, promedio_m2_tipo_zona: null, semaforo: "sin_datos_suficientes" };
    }

    const diferencia = (_precio_m2 - promedioTipo) / promedioTipo; // negativo = más barato que el promedio

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
      precio_m2: Math.round(_precio_m2),
      promedio_m2_tipo_zona: Math.round(promedioTipo),
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

  fs.writeFileSync(
    rutaSalida,
    JSON.stringify(
      {
        generado_en: new Date().toISOString(),
        basado_en: archivoReciente,
        promedios_m2_por_tipo: Object.fromEntries(
          [...promedioPorTipo.entries()].map(([tipo, valor]) => [tipo, Math.round(valor)])
        ),
        resumen: conteo,
        fichas: fichasAnalizadas,
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`✓ Guardado en ${rutaSalida}`);
}

main();
