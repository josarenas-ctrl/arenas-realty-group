// ARI — Deduplicación asistida por IA (segunda pasada)
//
// Corre DESPUÉS de dedupe.js. Las reglas de dedupe.js ya agruparon lo
// obvio (precio+specs muy parecidos, o precio casi igual + título con
// suficientes palabras distintivas en común). Lo que queda son fichas que
// SIGUEN separadas — este script busca, entre esas, pares "candidatos
// dudosos": mismo tipo de propiedad, mismo estado, precio dentro de un
// rango más amplio (25%), pero que las reglas no unieron porque el
// título no cumplía el umbral exacto. Sobre esos pares — y SOLO esos, no
// todos contra todos — le pregunta a la IA si son la misma propiedad.
//
// Por qué así y no "IA sobre todo": con cientos o miles de fichas, una
// IA comparando cada par posible agotaría cualquier cuota gratuita en
// una sola corrida. Reduciendo primero con reglas baratas a un puñado de
// candidatos, el uso de IA se queda dentro del nivel gratuito.
//
// Backends: Groq (principal, gratuito, 30 RPM) > Gemini (respaldo).
// Variables de entorno: GROQ_API_KEY, GEMINI_API_KEY.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const TOLERANCIA_PRECIO_CANDIDATO = 0.10;
const MAX_COMPARACIONES_IA = 0; // 0 = sin límite: el filtro inteligente ya reduce
const PAUSA_ENTRE_LLAMADAS_MS = 4000;
const GROQ_MODELO = "llama-3.3-70b-versatile";
const GEMINI_MODELO = "gemini-2.0-flash";

function precioComoNumero(precioTexto) {
  if (!precioTexto) return null;
  const limpio = String(precioTexto).replace(/[^\d]/g, "");
  const numero = parseInt(limpio, 10);
  return isNaN(numero) || numero === 0 ? null : numero;
}

function extraerEstado(ubicacion) {
  if (!ubicacion || !ubicacion.includes(",")) return null;
  const partes = ubicacion.split(",");
  return partes[partes.length - 1].trim();
}

function encontrarFichasMaestrasMasReciente() {
  const archivos = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.startsWith("fichas-maestras-") && f.endsWith(".json"))
    .sort();
  if (archivos.length === 0) return null;
  return archivos[archivos.length - 1];
}

function encontrarCandidatos(fichas) {
  const candidatos = [];
  for (let i = 0; i < fichas.length; i++) {
    for (let j = i + 1; j < fichas.length; j++) {
      const a = fichas[i];
      const b = fichas[j];

      if (!a.tipo || a.tipo !== b.tipo) continue;

      const estadoA = extraerEstado(a.ubicacion);
      const estadoB = extraerEstado(b.ubicacion);
      if (!estadoA || estadoA !== estadoB) continue;

      const precioA = precioComoNumero(a.precio_texto);
      const precioB = precioComoNumero(b.precio_texto);
      if (!precioA || !precioB) continue;
      const diferencia = Math.abs(precioA - precioB) / Math.max(precioA, precioB);
      if (diferencia > TOLERANCIA_PRECIO_CANDIDATO) continue;

      if (!a.habitaciones || !a.banos || !a.metros_cuadrados) continue;
      if (!b.habitaciones || !b.banos || !b.metros_cuadrados) continue;

      const algunaCoincide =
        a.habitaciones === b.habitaciones ||
        a.banos === b.banos ||
        a.metros_cuadrados === b.metros_cuadrados;
      if (!algunaCoincide) continue;

      const todasCoinciden =
        a.habitaciones === b.habitaciones &&
        a.banos === b.banos &&
        a.metros_cuadrados === b.metros_cuadrados;
      if (todasCoinciden) continue;

      candidatos.push({ i, j, diferenciaPrecio: diferencia });
    }
  }
  candidatos.sort((a, b) => a.diferenciaPrecio - b.diferenciaPrecio);
  return MAX_COMPARACIONES_IA > 0
    ? candidatos.slice(0, MAX_COMPARACIONES_IA)
    : candidatos;
}

async function dormir(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function armarPrompt(fichaA, fichaB) {
  return `Eres un asistente que compara dos publicaciones inmobiliarias para decidir si son la MISMA propiedad publicada dos veces (por ejemplo, por distintos asesores o en distintos momentos), o si son DOS propiedades distintas que solo coinciden en precio y tipo por casualidad.

Publicación A:
Título: "${fichaA.titulo}"
Precio: ${fichaA.precio_texto}
Habitaciones: ${fichaA.habitaciones || "no especificado"}
Baños: ${fichaA.banos || "no especificado"}
Metros cuadrados: ${fichaA.metros_cuadrados || "no especificado"}
Ubicación: ${fichaA.ubicacion || "no especificada"}

Publicación B:
Título: "${fichaB.titulo}"
Precio: ${fichaB.precio_texto}
Habitaciones: ${fichaB.habitaciones || "no especificado"}
Baños: ${fichaB.banos || "no especificado"}
Metros cuadrados: ${fichaB.metros_cuadrados || "no especificado"}
Ubicación: ${fichaB.ubicacion || "no especificada"}

Responde ÚNICAMENTE con un JSON de esta forma exacta, sin texto adicional:
{"misma_propiedad": true o false, "razon": "una frase breve explicando por qué"}`;
}

async function consultarGroq(fichaA, fichaB, apiKey) {
  const prompt = armarPrompt(fichaA, fichaB);
  const respuesta = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODELO,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 200,
    }),
  });

  if (!respuesta.ok) {
    const texto = await respuesta.text().catch(() => "");
    throw new Error(`Groq respondió ${respuesta.status}: ${texto.slice(0, 200)}`);
  }

  const data = await respuesta.json();
  const textoRespuesta = data?.choices?.[0]?.message?.content;
  if (!textoRespuesta) throw new Error("Groq: respuesta sin contenido");

  const parseado = JSON.parse(textoRespuesta);
  return {
    mismaPropiedad: parseado.misma_propiedad === true,
    razon: parseado.razon || "",
  };
}

async function consultarGemini(fichaA, fichaB, apiKey) {
  const prompt = armarPrompt(fichaA, fichaB);
  const respuesta = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODELO}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );

  if (!respuesta.ok) {
    const texto = await respuesta.text().catch(() => "");
    throw new Error(`Gemini respondió ${respuesta.status}: ${texto.slice(0, 200)}`);
  }

  const data = await respuesta.json();
  const textoRespuesta = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textoRespuesta) throw new Error("Gemini: respuesta sin contenido");

  const parseado = JSON.parse(textoRespuesta);
  return {
    mismaPropiedad: parseado.misma_propiedad === true,
    razon: parseado.razon || "",
  };
}

async function preguntarleALaIA(fichaA, fichaB, backend, apiKey) {
  const MAX_INTENTOS = 3;
  let ultimoError;

  for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
    try {
      if (backend === "groq") return await consultarGroq(fichaA, fichaB, apiKey);
      if (backend === "gemini") return await consultarGemini(fichaA, fichaB, apiKey);
      throw new Error(`Backend desconocido: ${backend}`);
    } catch (err) {
      ultimoError = err;
      const texto = err.message || "";
      const esTemporal = texto.includes("429") || texto.includes("503") || texto.includes("rate_limit");

      if (!esTemporal || intento === MAX_INTENTOS) break;

      const esperaMs = 5000 * intento;
      console.log(`  ⏳ Intento ${intento} falló (${backend}), reintentando en ${esperaMs / 1000}s...`);
      await dormir(esperaMs);
    }
  }

  throw ultimoError;
}

function fusionarFichas(principal, secundaria) {
  return {
    ...principal,
    total_publicaciones_encontradas:
      principal.total_publicaciones_encontradas + secundaria.total_publicaciones_encontradas,
    todos_los_anuncios: [...principal.todos_los_anuncios, ...secundaria.todos_los_anuncios],
  };
}

async function main() {
  // Elegir backend: Groq > Gemini
  const groqKey = process.env.GROQ_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;
  let backend, apiKey;

  if (groqKey) {
    backend = "groq";
    apiKey = groqKey;
    console.log("🔹 Backend IA: Groq (Llama 3.3 70B)");
  } else if (geminiKey) {
    backend = "gemini";
    apiKey = geminiKey;
    console.log("🔹 Backend IA: Gemini");
  } else {
    console.log("⚠️  No hay GROQ_API_KEY ni GEMINI_API_KEY — saltando deduplicación IA.");
    return;
  }

  const archivoReciente = encontrarFichasMaestrasMasReciente();
  if (!archivoReciente) {
    console.log("No se encontró ningún archivo fichas-maestras-*.json en ari/data/");
    return;
  }

  const rutaArchivo = path.join(DATA_DIR, archivoReciente);
  const contenido = JSON.parse(fs.readFileSync(rutaArchivo, "utf-8"));
  const fichas = contenido.fichas || [];

  const candidatos = encontrarCandidatos(fichas);
  console.log(`Candidatos dudosos encontrados: ${candidatos.length}${MAX_COMPARACIONES_IA > 0 ? ` (máximo ${MAX_COMPARACIONES_IA} por corrida)` : ""}`);

  if (candidatos.length === 0) {
    console.log("Nada que revisar con IA esta vez.");
    return;
  }

  const yaFusionado = new Set();
  const paresFusionar = [];
  let erroresConsecutivos = 0;
  const MAX_ERRORES_CONSECUTIVOS = 5;

  for (const candidato of candidatos) {
    if (yaFusionado.has(candidato.i) || yaFusionado.has(candidato.j)) continue;

    const fichaA = fichas[candidato.i];
    const fichaB = fichas[candidato.j];

    try {
      const resultado = await preguntarleALaIA(fichaA, fichaB, backend, apiKey);
      erroresConsecutivos = 0;
      console.log(
        `  "${fichaA.titulo.slice(0, 40)}..." vs "${fichaB.titulo.slice(0, 40)}..." → ${
          resultado.mismaPropiedad ? "MISMA" : "distintas"
        } (${resultado.razon})`
      );
      if (resultado.mismaPropiedad) {
        paresFusionar.push({ i: candidato.i, j: candidato.j });
        yaFusionado.add(candidato.i);
        yaFusionado.add(candidato.j);
      }
    } catch (err) {
      erroresConsecutivos++;
      console.error(`  ✗ Error consultando ${backend}:`, err.message);
      if (erroresConsecutivos >= MAX_ERRORES_CONSECUTIVOS) {
        console.log(`⚠️  ${MAX_ERRORES_CONSECUTIVOS} errores consecutivos — cuota agotada. Abortando fase IA.`);
        break;
      }
    }

    await dormir(PAUSA_ENTRE_LLAMADAS_MS);
  }

  if (paresFusionar.length === 0) {
    console.log("La IA no encontró duplicados adicionales esta vez.");
    return;
  }

  console.log(`✓ La IA confirmó ${paresFusionar.length} par(es) adicional(es) de duplicados.`);

  const indicesAEliminar = new Set();
  let fichasFinal = [...fichas];

  for (const { i, j } of paresFusionar) {
    const principal =
      fichasFinal[i].total_publicaciones_encontradas >= fichasFinal[j].total_publicaciones_encontradas
        ? i
        : j;
    const secundaria = principal === i ? j : i;
    fichasFinal[principal] = fusionarFichas(fichasFinal[principal], fichasFinal[secundaria]);
    indicesAEliminar.add(secundaria);
  }

  fichasFinal = fichasFinal.filter((_, idx) => !indicesAEliminar.has(idx));
  fichasFinal.sort((a, b) => b.total_publicaciones_encontradas - a.total_publicaciones_encontradas);

  contenido.fichas = fichasFinal;
  contenido.total_fichas_maestras = fichasFinal.length;
  contenido.revisado_por_ia_en = new Date().toISOString();

  fs.writeFileSync(rutaArchivo, JSON.stringify(contenido, null, 2), "utf-8");
  console.log(`✓ Actualizado ${archivoReciente}: ${fichasFinal.length} fichas maestras finales.`);
}

main();