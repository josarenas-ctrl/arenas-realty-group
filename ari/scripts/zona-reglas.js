const fs = require("fs");
const CACHE = process.env.CACHE_FILE || "/root/ari-cache/zona-ia-cache.json";
const planas = (s) => String(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const SIN_ART = (s) => s.replace(/^(la|el|los|las)\s+/, "");
const NO_ZONA = new Set(["baruta","chacao","el hatillo","sucre","libertador","zamora","paez","guaicaipuro","urdaneta","vargas","independencia","plaza","guarenas","guatire","charallave","carrizal","maiquetia","catia","mariche","gavilan","horizonte","la sabana","la pena","agua sal","aguasal","palm beach","higuerote","tanaguarena","mampote","caracas","maracay","miranda","distrito capital","la guaira","centro","venezuela","cua"]);
const NO_ES_LUGAR = new Set(["la cocina","cocina","pb","ph","planta baja","oficina","local","apartamento","casa","galpon","terreno","edificio","townhouse","anexo","penthouse","venta","alquiler","zonaven","local industrial","galpon industrial","zona industrial","zona in","urbanizacion","el edificio","edificio"]);

function evaluar(raw, titulo) {
  let z = String(raw || "").split("\n")[0].trim();
  z = z.replace(/^["'“«\s]+|["'”».\s]+$/g, "").replace(/\s+/g, " ");
  if (!z) return [null, "vacia"];
  if (/^ninguna\b/i.test(z)) return [null, "ninguna"];
  if (z.length > 40 || z.split(" ").length > 6) return [null, "larga"];
  if (/[:;]|^(la zona|el t[ií]tulo|el nombre|no se|no hay|lo siento)/i.test(z)) return [null, "frase"];
  const p = planas(z);
  if (p.length < 3) return [null, "corta"];
  if (NO_ZONA.has(p)) return [null, "no_area"];
  if (NO_ES_LUGAR.has(p)) return [null, "no_lugar"];
  if (/(^| )(c c|cc|centro comercial)( |$)/.test(p)) return [null, "no_lugar"];
  const nucleo = SIN_ART(p);
  if (nucleo.length < 3) return [null, "corta"];
  if (titulo && !(" " + planas(titulo) + " ").includes(" " + nucleo + " ")) return [null, "no_en_titulo"];
  return [z, "ok"];
}

function procesar(cache) {
  const res = {};
  const grupos = new Map();
  for (const [k, v] of Object.entries(cache)) {
    const [z, motivo] = evaluar(v.raw, k);
    res[k] = { zona: z, motivo };
    if (z) {
      const clave = SIN_ART(planas(z));
      if (!grupos.has(clave)) grupos.set(clave, new Map());
      const g = grupos.get(clave);
      g.set(z, (g.get(z) || 0) + 1);
    }
  }
  const canon = new Map();
  for (const [clave, g] of grupos) canon.set(clave, [...g.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0]);
  for (const r of Object.values(res)) if (r.zona) r.zona = canon.get(SIN_ART(planas(r.zona)));
  return { res, grupos };
}
module.exports = { evaluar, procesar };

if (require.main === module) {
  console.log("=== mini-prueba con casos conocidos ===");
  const pruebas = [
    ["La Poma Rosa", "Casa Urb La Poma Rosa Av Perimetral"],
    ["Higuerote", "Hotel Boutique En Higuerote"],
    ["Aguasal", "Apartamento En Venta - Aguasal (higuerote)"],
    ["El Hatillo", "Se Vende Apartamento En El Hatillo"],
    ["Chacao", "Alquiler Oficina En Chacao 211 M2"],
    ["La Cocina", "(bello apto venta amoblado la cocina )residencia:solar quinta etapa 4 metr"],
    ["Pb", "Apartamento En Pb Perfecto Para Quienes Buscan"],
    ["Las Mercedes", "Venta Casa En Santa Rosa De Lima 370 M2 4 Hab"],
  ];
  for (const [raw, titulo] of pruebas) {
    const [z, m] = evaluar(raw, titulo);
    console.log((z ? "OK" : "RECH"), raw, "->", z || m);
  }
  console.log("=== aplicando a cache real ===");
  const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
  const { res, grupos } = procesar(c);
  const val = Object.values(res).filter(r => r.zona).length;
  const uniq = new Set(Object.values(res).filter(r => r.zona).map(r => r.zona)).size;
  console.log("validadas:", val, "| zonas canonicas:", uniq);
  console.log("rechazos por motivo:");
  const rm = {};
  for (const r of Object.values(res)) if (!r.zona) rm[r.motivo] = (rm[r.motivo] || 0) + 1;
  console.log(rm);
  const tmp = CACHE + ".canon.tmp";
  fs.writeFileSync(tmp, JSON.stringify(res));
  fs.renameSync(tmp, CACHE + ".canon.json");
  console.log("escrito", CACHE + ".canon.json");
}
