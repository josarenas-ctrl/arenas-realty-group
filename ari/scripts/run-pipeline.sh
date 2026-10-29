#!/bin/bash
set -euo pipefail
exec 9>/var/lock/ari-pipeline.lock
if ! flock -n 9; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [PIPELINE] ⚠️ Pipeline ya en ejecución. Abortando." >> /var/log/ari-pipeline.log
    exit 0
fi
ARCHIVO_DB="${1:-}"
LOG_FILE="/var/log/ari-pipeline.log"
ARI_DIR="/root/arenas-realty-group/ari"
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [PIPELINE] $1" | tee -a "$LOG_FILE"; }
log "=== Iniciando pipeline ==="
log "Archivo: $ARCHIVO_DB"
[ -f "$ARCHIVO_DB" ] || { log "❌ No existe"; exit 1; }
sqlite3 "$ARCHIVO_DB" ".tables" >/dev/null 2>&1 || { log "❌ No es SQLite válido o no accesible"; exit 1; }
TAMANO=$(stat -c%s "$ARCHIVO_DB" 2>/dev/null || echo 0)
[ "$TAMANO" -ge 1024 ] || { log "❌ Muy pequeño ($TAMANO bytes)"; exit 1; }
log "✅ SQLite válido ($TAMANO bytes)"
cd "$ARI_DIR"
log "📥 Importando ML..."
node scripts/importar-ml.js || { log "❌ Falló import"; exit 1; }
log "🧹 Dedupe..."
npm run dedupe || { log "❌ Falló dedupe"; exit 1; }
log "🤖 IA-Dedupe..."
npm run ia-dedupe || log "⚠️ IA-Dedupe falló (continuando)"
log "📊 Análisis..."
npm run analizar || { log "❌ Falló análisis"; exit 1; }
log "=== Pipeline completado ==="

# AUTO-PUSH a GitHub (solo pipeline local pushea ultimo-analisis.json)
cd /root/arenas-realty-group
git config user.name "ari-bot"
git config user.email "ari-bot@users.noreply.github.com"

# 1. Preparar y commitear TODOS los archivos generados por pipeline
git add ari/data/ultimo-analisis.json
git add ari/data/analisis-*.json 2>/dev/null || true
git add ari/data/fichas-maestras-*.json 2>/dev/null || true

# 2. Si hay cambios, commitear
if ! git diff --staged --quiet; then
    git commit -m "ARI: auto-update from local pipeline $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    
    # 3. Pull con rebase y autostash (maneja automáticamente los cambios locales tracked)
    if git pull --rebase --autostash origin cloudflare-test 2>&1 | tee -a "$LOG_FILE"; then
        # 4. Push
        if git push origin cloudflare-test 2>&1 | tee -a "$LOG_FILE"; then
            log "✅ Push a GitHub completado → Cloudflare Pages deployará automáticamente"
        else
            log "❌ Push falló. Revisar credenciales o conflictos."
        fi
    else
        log "❌ Pull --rebase falló. Revisar conflictos."
    fi
else
    log "ℹ️ Sin cambios en datos, no hay push necesario"
fi