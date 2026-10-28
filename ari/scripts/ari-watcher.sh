#!/bin/bash
set -euo pipefail

LOG_FILE="/var/log/ari-pipeline.log"
WATCH_DIR="/root/servidor-hermes/"
PIPELINE="/root/arenas-realty-group/ari/scripts/run-pipeline.sh"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] [WATCHER] $1" | tee -a "$LOG_FILE"; }

# Manejo de señales para limpieza
INOTIFY_PID=""
cleanup() {
    log "Recibida señal de terminación. Cerrando watcher..."
    if [ -n "$INOTIFY_PID" ]; then
        kill "$INOTIFY_PID" 2>/dev/null || true
    fi
    exit 0
}
trap cleanup SIGTERM SIGINT

log "Iniciando watcher en $WATCH_DIR (con process substitution + mtime check)"

# OPCIÓN B: Usar process substitution (< <(...)) para evitar re-lectura del buffer
while read -r FILE; do
    if [[ "$FILE" == *"inmuebles.db"* ]]; then
        
        # OPCIÓN A: Verificar mtime (archivo modificado en los últimos 5 minutos)
        if [ ! -f "$FILE" ]; then
            log "Archivo $FILE ya no existe. Ignorando."
            continue
        fi
        
        MTIME=$(stat -c %Y "$FILE" 2>/dev/null || echo 0)
        NOW=$(date +%s)
        DIFF=$(( NOW - MTIME ))
        
        if (( DIFF > 300 )); then
            log "Archivo viejo (mtime: $MTIME, hace $DIFF seg). Ignorando."
            continue
        fi
        
        log "Detectado cambio real en $FILE (mtime: $MTIME, hace $DIFF seg)"
        
        # Ejecutar pipeline
        if "$PIPELINE" "$FILE"; then
            log "Pipeline completado OK"
        else
            log "Pipeline terminado con error (código $?)"
        fi
    fi
done < <(/usr/bin/inotifywait -m -e close_write --format '%w%f' "$WATCH_DIR")
