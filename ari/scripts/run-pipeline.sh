#!/bin/bash
# ARI - pipeline local (VPS) - v2 (2026-10-31)
#
# Que cambia respecto a v1 (la v1 se guarda como run-pipeline.sh.v1-20261031):
#  1. Trae los cambios del repo (git pull --rebase) ANTES de generar datos.
#  2. Compuerta de calidad antes de publicar: si el JSON sale mal, NO se publica
#     y se guarda una copia en ari/data/_rechazados/ para revisarlo.
#  3. Los fallos ya no se maquillan: el script termina con codigo distinto de 0
#     y el watcher lo registra como error (antes decia "completado OK").
#  4. "completado" solo se escribe si el push funciono.
#  5. Sin --autostash y sin --force. Si hay conflicto se aborta el rebase y se avisa.
#
# Los umbrales de la compuerta se pueden cambiar sin editar el script:
#   ARI_MIN_FICHAS, ARI_MAX_PCT_SIN_TITULO, ARI_MAX_PCT_SIN_UBICACION,
#   ARI_MAX_PCT_M2_ESTIMADO, ARI_MIN_PCT_VS_ANTERIOR
set -Eeuo pipefail

LOG_FILE="${ARI_LOG_FILE:-/var/log/ari-pipeline.log}"
LOCK_FILE="${ARI_LOCK_FILE:-/var/lock/ari-pipeline.lock}"
ARI_DIR="${ARI_DIR:-/root/arenas-realty-group/ari}"
REPO_DIR="${ARI_REPO_DIR:-/root/arenas-realty-group}"
RAMA="${ARI_RAMA:-cloudflare-test}"

MIN_FICHAS="${ARI_MIN_FICHAS:-1000}"
MAX_PCT_SIN_TITULO="${ARI_MAX_PCT_SIN_TITULO:-1}"
MAX_PCT_SIN_UBICACION="${ARI_MAX_PCT_SIN_UBICACION:-2}"
MAX_PCT_M2_ESTIMADO="${ARI_MAX_PCT_M2_ESTIMADO:-10}"
MIN_PCT_VS_ANTERIOR="${ARI_MIN_PCT_VS_ANTERIOR:-60}"

GENERANDO=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [PIPELINE] $1" | tee -a "$LOG_FILE"; }

# Termina con error visible. Si ya se estaba generando datos, restaura los
# archivos RASTREADOS de ari/data (lo que hay en git) para no dejar el repo sucio.
fallar() {
    log "❌ $1"
    if [ "$GENERANDO" = 1 ]; then
        git -C "$REPO_DIR" checkout -- ari/data 2>/dev/null || true
    fi
    exit "${2:-1}"
}

trap 'log "❌ Error inesperado en la linea $LINENO"' ERR

# --- Candado: una sola corrida a la vez ---
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "⚠️ OMITIDO: ya hay un pipeline en ejecucion. Esta corrida NO se hizo; si llego un inmuebles.db nuevo, hay que relanzar cuando termine la otra."
    exit 3
fi

ARCHIVO_DB="${1:-}"
log "=== Iniciando pipeline v2 ==="
log "Archivo: $ARCHIVO_DB"
[ -f "$ARCHIVO_DB" ] || fallar "No existe"
sqlite3 "$ARCHIVO_DB" ".tables" >/dev/null 2>&1 || fallar "No es SQLite valido o no accesible"
TAMANO=$(stat -c%s "$ARCHIVO_DB" 2>/dev/null || echo 0)
[ "$TAMANO" -ge 1024 ] || fallar "Muy pequeño ($TAMANO bytes)"
log "✅ SQLite valido ($TAMANO bytes)"
command -v jq >/dev/null 2>&1 || fallar "Falta jq (necesario para la compuerta de calidad)"

# --- Estado de git antes de empezar ---
cd "$REPO_DIR"
git config user.name "ari-bot"
git config user.email "ari-bot@users.noreply.github.com"

if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
    fallar "Hay un rebase a medias en el repo. No se continua. Revisar a mano con git status."
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
    log "Archivos rastreados con cambios:"
    git status --short | grep -v '^??' | tee -a "$LOG_FILE" || true
    fallar "El repo tiene cambios sin confirmar en archivos rastreados. No se continua."
fi

log "🔄 Trayendo cambios del repo..."
ANTES=$(git rev-parse --short HEAD)
if ! git pull --rebase origin "$RAMA" 2>&1 | tee -a "$LOG_FILE"; then
    git rebase --abort 2>/dev/null || true
    fallar "git pull --rebase fallo (conflicto o sin conexion). No se genero nada."
fi
log "Repo: $ANTES -> $(git rev-parse --short HEAD)"

# --- Generacion de datos (igual que v1) ---
cd "$ARI_DIR"
GENERANDO=1
log "📥 Importando ML..."
node scripts/importar-ml.js || fallar "Fallo import"
log "🧹 Dedupe..."
npm run dedupe || fallar "Fallo dedupe"
log "🤖 IA-Dedupe..."
npm run ia-dedupe || log "⚠️ IA-Dedupe fallo (continuando)"
log "📊 Analisis..."
npm run analizar || fallar "Fallo analisis"

# --- Compuerta de calidad ---
compuerta() {
    local f="$ARI_DIR/data/ultimo-analisis.json"
    [ -s "$f" ] || { log "Compuerta: no existe ultimo-analisis.json"; return 1; }
    jq -e '.fichas | type == "array"' "$f" >/dev/null 2>&1 || { log "Compuerta: JSON invalido o sin lista de fichas"; return 1; }

    local total sin_t sin_u est prev ok=0
    total=$(jq '.fichas | length' "$f")
    sin_t=$(jq '[.fichas[] | select((.titulo // "") == "")] | length' "$f")
    sin_u=$(jq '[.fichas[] | select((.ubicacion // "") == "")] | length' "$f")
    est=$(jq '[.fichas[] | select(.m2_estimado == true)] | length' "$f")
    prev=$(git -C "$REPO_DIR" show "HEAD:ari/data/ultimo-analisis.json" 2>/dev/null | jq '.fichas | length' 2>/dev/null || echo 0)
    prev="${prev:-0}"

    log "Compuerta: fichas=$total sin_titulo=$sin_t sin_ubicacion=$sin_u m2_estimado=$est anterior=$prev"

    if [ "$total" -lt "$MIN_FICHAS" ]; then
        log "Compuerta: muy pocas fichas ($total < $MIN_FICHAS)"; ok=1
    fi
    if [ $((sin_t * 100)) -gt $((total * MAX_PCT_SIN_TITULO)) ]; then
        log "Compuerta: demasiadas fichas sin titulo ($sin_t de $total, maximo ${MAX_PCT_SIN_TITULO}%)"; ok=1
    fi
    if [ $((sin_u * 100)) -gt $((total * MAX_PCT_SIN_UBICACION)) ]; then
        log "Compuerta: demasiadas fichas sin ubicacion ($sin_u de $total, maximo ${MAX_PCT_SIN_UBICACION}%)"; ok=1
    fi
    if [ $((est * 100)) -gt $((total * MAX_PCT_M2_ESTIMADO)) ]; then
        log "Compuerta: demasiadas fichas con m2 estimado ($est de $total, maximo ${MAX_PCT_M2_ESTIMADO}%)"; ok=1
    fi
    if [ "$prev" -gt 0 ] && [ $((total * 100)) -lt $((prev * MIN_PCT_VS_ANTERIOR)) ]; then
        log "Compuerta: cayo demasiado frente a lo publicado ($total vs $prev, minimo ${MIN_PCT_VS_ANTERIOR}%)"; ok=1
    fi
    return "$ok"
}

if ! compuerta; then
    REJ="$ARI_DIR/data/_rechazados/$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir -p "$REJ"
    cp "$ARI_DIR/data/ultimo-analisis.json" "$REJ/" 2>/dev/null || true
    fallar "La compuerta de calidad rechazo el resultado. NO se publico. Copia para revisar en: $REJ"
fi
log "✅ Compuerta de calidad superada"

# --- Publicar ---
cd "$REPO_DIR"
git add ari/data/ultimo-analisis.json
git add ari/data/analisis-*.json ari/data/fichas-maestras-*.json 2>/dev/null || true

if git diff --cached --quiet; then
    GENERANDO=0
    log "ℹ️ Sin cambios en datos, no hay push necesario"
    log "=== Pipeline v2 terminado (sin cambios) ==="
    exit 0
fi

git commit -q -m "ARI: auto-update from local pipeline $(date -u +%Y-%m-%dT%H:%M:%SZ)"
GENERANDO=0

PUSH_OK=0
for intento in 1 2 3; do
    if git push origin "$RAMA" 2>&1 | tee -a "$LOG_FILE"; then
        PUSH_OK=1
        break
    fi
    log "⚠️ Push rechazado (intento $intento/3); integrando cambios del remoto..."
    if ! git pull --rebase origin "$RAMA" 2>&1 | tee -a "$LOG_FILE"; then
        git rebase --abort 2>/dev/null || true
        fallar "Rebase con conflicto. NO se publico nada. El commit local queda en $(git rev-parse --short HEAD)."
    fi
done
[ "$PUSH_OK" = 1 ] || fallar "No se pudo publicar tras 3 intentos. El commit local queda sin publicar."

log "✅ Publicado en $RAMA ($(git rev-parse --short HEAD)) → Cloudflare Pages desplegara automaticamente"
log "=== Pipeline v2 completado ==="
