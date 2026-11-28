const fs = require("fs");
const path = require("path");
const URL_API = process.env.LLAMA_URL || "http://100.107.119.89:8080/v1/chat/completions";
const DIR = process.env.CACHE_DIR || path.join(__dirname, "..", "data");
const CACHE = path.join(DIR, "zona-ia-cache.json");
const LOCK = path.join(DIR, ".lock");
const DATA = process.env.DATA_FILE || "/root/arenas-realty-group/ari/data/ultimo-analisis.json";
const MODELO = "llama-3.2-3b-instruct-q4_k_m";
const PROMPT_V = "v1";
const PROMPT = "Dado un titulo de anuncio inmobiliario venezolano, devuelve solo el nombre de la urbanizacion o zona. Si solo menciona municipio (Sucre, Baruta, Chacao, Libertador, El Hatillo) o ciudad (Caracas), responde NINGUNA.\n\nTitulo: ";
const NO_ZONA = new Set(["baruta","chacao","el hatillo","sucre","libertador","zamora","paez","guaicaipuro","urdaneta","vargas","independencia","plaza","guarenas","guatire","charallave","carrizal","maiquetia","catia","mariche","gavilan","horizonte","la sabana","la pena","agua sal","palm beach","higuerote","tanaguarena","mampote","caracas","maracay","miranda","distrito capital","la guaira","centro","venezuela"]);

function validar(raw) {
  let z = String(raw || "").split("\n")[0].trim();
  z = z.replace(/^["'“«\s]+|["'”».\s]+$/g, "").replace(/\s+/g, " ");
  if (!z) return [null, "vacia"];
  if (/^ninguna\b/i.test(z)) return [null, "ninguna"];
  if (z.length > 40 || z.split(" ").length > 6) return [null, "larga"];
  if (/[:;]|^(la zona|el t[ií]tulo|no se|no hay|lo siento)/i.test(raw)) return [null, "frase"];
  const k = z.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (NO_ZONA.has(k)) return [null, "no_area"];
  return [z, "ok"];
}
function guardar(c) {
  const tmp = CACHE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, CACHE);
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });
  try { fs.writeFileSync(LOCK, String(process.pid), { flag: "wx" }); }
  catch (e) {
    const pid = Number(fs.readFileSync(LOCK, "utf8"));
    let vivo = false;
    try { process.kill(pid, 0); vivo = true; } catch (_) {}
    if (vivo) { console.log("Ya hay una corrida en marcha (pid " + pid + "). Salgo."); process.exit(3); }
    fs.writeFileSync(LOCK, String(process.pid));
  }
  process.on("exit", () => { try { fs.unlinkSync(LOCK); } catch (_) {} });
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  try {
    const r = await fetch(new URL(URL_API).origin + "/health", { signal: AbortSignal.timeout(45000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
  } catch (e) {
    console.log("La caja no responde (" + e.message + "). Pausada? Despiertala con: instabox wake mi-llama. No se hizo nada.");
    process.exit(2);
  }

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, "utf8")); } catch (_) {}
  const d = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const a = Array.isArray(d) ? d : (d.fichas || Object.values(d).find(Array.isArray) || []);
  const vistos = new Set();
  let pend = [];
  for (const f of a) {
    const t = (f.titulo || "").trim();
    const k = t.toLowerCase();
    if (!t || vistos.has(k) || cache[k]) continue;
    vistos.add(k);
    pend.push([k, t]);
  }
  const total = pend.length;
  const N = Number(process.argv[2]);
  if (N) {
    for (let i = pend.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pend[i], pend[j]] = [pend[j], pend[i]]; }
    pend = pend.slice(0, N);
  }
  console.log("Titulos unicos pendientes: " + total + " | a procesar ahora: " + pend.length);

  let ok = 0, nul = 0, err = 0, seguidos = 0, n = 0, mostrados = 0;
  const rech = {};
  const t0 = Date.now();
  for (const [k, t] of pend) {
    let raw;
    try {
      const r = await fetch(URL_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ temperature: 0, max_tokens: 20, messages: [{ role: "user", content: PROMPT + t }] }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      raw = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "").trim();
      seguidos = 0;
    } catch (e) {
      err++; seguidos++;
      if (seguidos >= 3) { console.log("3 errores seguidos (" + e.message + "): la caja dejo de responder. Guardo y salgo; se puede reanudar."); break; }
      continue;
    }
    const [z, motivo] = validar(raw);
    cache[k] = { raw: raw.slice(0, 80), zona: z, modelo: MODELO, prompt: PROMPT_V, fecha: new Date().toISOString().slice(0, 10) };
    if (z) {
      ok++;
      if (mostrados < 10) { console.log("OK   " + t.slice(0, 70) + " => " + z); mostrados++; }
    } else {
      nul++; rech[motivo] = (rech[motivo] || 0) + 1;
      if (motivo !== "ninguna") console.log("RECH " + t.slice(0, 70) + " => " + raw.slice(0, 40) + " [" + motivo + "]");
    }
    if (++n % 50 === 0) guardar(cache);
  }
  guardar(cache);
  console.log("--- resumen --- procesados " + n + " | zona valida " + ok + " | sin zona " + nul + " " + JSON.stringify(rech) + " | errores " + err + " | " + ((Date.now() - t0) / 1000).toFixed(0) + "s | cache " + Object.keys(cache).length + " entradas");
})();
