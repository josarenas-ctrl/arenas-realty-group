// ARI — Deduplicación de anuncios
//
// Lee todos los archivos de ari/data/<zona>-<portal>-<fecha>.json más
// recientes (uno por zona+portal), junta todos los anuncios, y los agrupa
// en "fichas maestras" cuando parecen ser la misma propiedad publicada
// más de una vez.
//
// Cómo decide que dos anuncios son la misma propiedad (sin usar IA, solo
// reglas — la IA entra después, sobre las fichas ya agrupadas):
//   1. Mismo precio exacto (precio_texto normalizado)
//   2. Mismas habitaciones, baños y metros cuadrados
//   3. Títulos con al menos 40% de palabras en común (evita que dos
//      propiedades distintas con el mismo precio por casualidad se agrupen)
//
// Cuando un anuncio no tiene specs completas (habitaciones/baños/m² en
// null), se agrupa solo por precio + similitud de título, con un umbral
// de similitud más exigente (60%) ya que hay menos señales para confirmar.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function normalizarPrecio(precioTexto) {
  if (!precioTexto) return "";
  return precioTexto.replace(/[^\d]/g, ""); // deja solo dígitos
}

function palabrasDe(texto) {
  return new Set(
    texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // quita acentos
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((p) => p.length > 2) // ignora palabras muy cortas (en, de, la...)
  );
}

function similitudTitulos(a, b) {
  const palabrasA = palabrasDe(a);
  const palabrasB = palabrasDe(b);
  if (palabrasA.size === 0 || palabrasB.size === 0) return 0;

  let comunes = 0;
  for (const palabra of palabrasA) {
    if (palabrasB.has(palabra)) comunes++;
  }
  const menor = Math.min(palabrasA.size, palabrasB.size);
  return comunes / menor;
}

function sonLaMismaPropiedad(a, b) {
  const precioA = normalizarPrecio(a.precio_texto);
  const precioB = normalizarPrecio(b.precio_texto);
  if (!precioA || precioA !== precioB) return false;

  const similitud = similitudTitulos(a.titulo, b.titulo);
  const specsCompletas =
    a.habitaciones && a.banos && a.metros_cuadrados &&
    a.habitaciones === b.habitaciones &&
    a.banos === b.banos &&
    a.metros_cuadrados === b.metros_cuadrados;

  if (specsCompletas) {
    return similitud >= 0.4;
  }
  return similitud >= 0.6;
}

function agruparAnuncios(anuncios) {
  const grupos = [];
  const yaAgrupado = new Array(anuncios.length).fill(false);

  for (let i = 0; i < anuncios.length; i++) {
    if (yaAgrupado[i]) continue;
    const grupo = [anuncios[i]];
    yaAgrupado[i] = true;

    for (let j = i + 1; j < anuncios.length; j++) {
      if (yaAgrupado[j]) continue;
      if (sonLaMismaPropiedad(anuncios[i], anuncios[j])) {
        grupo.push(anuncios[j]);
        yaAgrupado[j] = true;
      }
    }
    grupos.push(grupo);
  }

  return grupos;
}

function elegirFichaMaestra(grupo) {
  // El "mejor" anuncio del grupo: el que tiene el título más largo
  // (normalmente el más descriptivo/profesional) y más specs completas.
  return grupo.slice().sort((a, b) => {
    const completitudA = [a.habitaciones, a.banos, a.metros_cuadrados, a.ubicacion].filter(Boolean).length;
    const completitudB = [b.habitaciones, b.banos, b.metros_cuadrados, b.ubicacion].filter(Boolean).length;
    if (completitudB !== completitudA) return completitudB - completitudA;
    return (b.titulo?.length || 0) - (a.titulo?.length || 0);
  })[0];
}

function encontrarArchivosMasRecientes() {
  const archivos = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("fichas-maestras"));
  const porClave = new Map(); // "zona-portal" -> { archivo, fecha }

  for (const archivo of archivos) {
    const match = archivo.match(/^(.+)-(\d{4}-\d{2}-\d{2})\.json$/);
    if (!match) continue;
    const [, claveZonaPortal, fecha] = match;

    const actual = porClave.get(claveZonaPortal);
    if (!actual || fecha > actual.fecha) {
      porClave.set(claveZonaPortal, { archivo, fecha });
    }
  }

  return [...porClave.values()].map((v) => v.archivo);
}

function main() {
  const archivosRecientes = encontrarArchivosMasRecientes();
  console.log(`Archivos de datos encontrados (más recientes por zona+portal): ${archivosRecientes.join(", ")}`);

  let todosLosAnuncios = [];
  for (const archivo of archivosRecientes) {
    const contenido = JSON.parse(fs.readFileSync(path.join(DATA_DIR, archivo), "utf-8"));
    const anunciosConFuente = (contenido.anuncios || []).map((a) => ({
      ...a,
      _zona: contenido.zona,
      _portal: contenido.portal,
    }));
    todosLosAnuncios.push(...anunciosConFuente);
  }

  console.log(`Total de anuncios cargados (todos los portales): ${todosLosAnuncios.length}`);

  const grupos = agruparAnuncios(todosLosAnuncios);
  console.log(`Agrupados en ${grupos.length} fichas maestras (de ${todosLosAnuncios.length} anuncios originales)`);

  const fichasMaestras = grupos.map((grupo) => {
    const maestra = elegirFichaMaestra(grupo);
    return {
      titulo: maestra.titulo,
      precio_texto: maestra.precio_texto,
      habitaciones: maestra.habitaciones,
      banos: maestra.banos,
      metros_cuadrados: maestra.metros_cuadrados,
      tipo: maestra.tipo,
      ubicacion: maestra.ubicacion,
      enlace_principal: maestra.enlace,
      portal_principal: maestra._portal,
      total_publicaciones_encontradas: grupo.length,
      todos_los_anuncios: grupo.map((a) => ({
        enlace: a.enlace,
        portal: a._portal,
        titulo: a.titulo,
      })),
    };
  });

  // Ordenar para que las propiedades con más publicaciones duplicadas
  // aparezcan primero — son las más "ruidosas" y las que más vale la pena
  // revisar para confirmar quién tiene la exclusiva real.
  fichasMaestras.sort((a, b) => b.total_publicaciones_encontradas - a.total_publicaciones_encontradas);

  const fecha = new Date().toISOString().slice(0, 10);
  const rutaSalida = path.join(DATA_DIR, `fichas-maestras-${fecha}.json`);
  fs.writeFileSync(
    rutaSalida,
    JSON.stringify(
      {
        generado_en: new Date().toISOString(),
        total_anuncios_originales: todosLosAnuncios.length,
        total_fichas_maestras: fichasMaestras.length,
        fichas: fichasMaestras,
      },
      null,
      2
    ),
    "utf-8"
  );
  console.log(`✓ Guardado en ${rutaSalida}`);
}

main();
