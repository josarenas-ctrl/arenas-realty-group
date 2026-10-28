const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_ML = "/root/servidor-hermes/inmuebles.db";

function generarJSON() {
    if (!fs.existsSync(DB_ML)) {
        console.error(`[IMPORT] ❌ No se encontró ${DB_ML}`);
        process.exit(1);
    }

    const stat = fs.statSync(DB_ML);
    if (stat.size < 1024) {
        console.error(`[IMPORT] ❌ Archivo muy pequeño (${stat.size} bytes)`);
        process.exit(1);
    }

    let db;
    let rows;
    const maxRetries = 3;
    const retryDelays = [1000, 2000, 4000];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            db = new DatabaseSync(DB_ML);
            rows = db.prepare("SELECT * FROM inmuebles").all();
            db.close();
            break;
        } catch (err) {
            if (err.code === "SQLITE_BUSY" || err.message?.includes("database is locked")) {
                if (attempt < maxRetries - 1) {
                    console.log(`[IMPORT] ⚠️ Base de datos bloqueada (intento ${attempt + 1}/${maxRetries}), reintentando en ${retryDelays[attempt]}ms...`);
                    require("fs").writeFileSync("/dev/null", ""); // no-op
                    setTimeout(() => {}, retryDelays[attempt]); // simple sleep
                    require("child_process").execSync(`sleep ${retryDelays[attempt] / 1000}`);
                    continue;
                }
            }
            console.error(`[IMPORT] ❌ Error leyendo SQLite: ${err.message}`);
            process.exit(1);
        }
    }

    console.log(`[IMPORT] 📥 Leídos ${rows.length} registros de inmuebles.db`);

    const anuncios = rows.map(row => ({
        titulo: row.titulo || "",
        enlace: row.url || "",
        precio_texto: row.precio ? `USD ${row.precio}` : "",
        habitaciones: row.habitaciones ?? null,
        banos: row.banos ?? null,
        metros_cuadrados: row.m2_cubiertos ?? null,
        tipo: row.tipo || "",
        operacion_detectada: row.operacion ? (row.operacion.charAt(0).toUpperCase() + row.operacion.slice(1).toLowerCase()) : "",
        ubicacion: row.ubicacion || "",
        _fuente: "ml_python",
    })).filter(a => {
        const precioNum = parseFloat(String(a.precio_texto).replace(/[^\d.]/g, ""));
        const m2 = a.metros_cuadrados;
        if (!precioNum || precioNum <= 0) {
            console.log(`[IMPORT] ⚠️ Omitido (precio inválido): ${a.titulo}`);
            return false;
        }
        if (m2 === null || m2 <= 0) {
            console.log(`[IMPORT] ⚠️ Omitido (m² inválido): ${a.titulo}`);
            return false;
        }
        if (!a.titulo || !a.titulo.trim()) {
            console.log(`[IMPORT] ⚠️ Omitido (título vacío)`);
            return false;
        }
        return true;
    });

    const fecha = new Date().toISOString().slice(0, 10);
    const resultado = {
        zona: "miranda-dc-guaira",
        portal: "mercadolibre",
        operacion: "todas",
        url_busqueda: "sqlite-local",
        scrapeado_en: new Date().toISOString(),
        total: anuncios.length,
        anuncios,
    };

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const rutaSalida = path.join(DATA_DIR, `mercadolibre-python-${fecha}.json`);
    fs.writeFileSync(rutaSalida, JSON.stringify(resultado, null, 2), "utf-8");
    console.log(`[IMPORT] ✅ Guardado en ${rutaSalida} (${anuncios.length} anuncios válidos)`);
}

generarJSON();