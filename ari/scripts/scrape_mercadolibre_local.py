# ARI — Scraper MercadoLibre Local (Playwright + Brave)
# 
# Conecta a Brave en modo debugging (puerto 9222) con la sesión activa del usuario.
# Scrapea busquedas de ML Venezuela definidas en busquedas.json.
# Guarda resultados en ari/data/zona-mercadolibre-fecha.json (mismo formato actual).
#
# USO:
#   1. Abrir Brave manualmente con: brave.exe --remote-debugging-port=9222
#   2. Asegurarse de estar logueado en MercadoLibre
#   3. python scrape-mercadolibre-local.py
#
# AUTOMATIZACION (Windows Task Scheduler):
#   Ejecutar semanalmente, script abre Brave automaticamente si no esta abierto.

import json
import os
import sys
import time
import random
import subprocess
from datetime import datetime
from playwright.sync_api import sync_playwright

# ══════════════════════════════════════════════════════════════════════════════
# CONFIGURACIÓN
# ══════════════════════════════════════════════════════════════════════════════

CONFIG_PATH = r"C:\Users\ASISTENTE\arenas-realty-group\ari\config\busquedas.json"
DATA_DIR = r"C:\Users\ASISTENTE\arenas-realty-group\ari\data"
LOG_DIR = r"C:\Users\ASISTENTE\temp-ml-scraper"
BRAVE_PATH = r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
DEBUG_PORT = 9222

# Delays aleatorios entre requests (segundos) — anti-detección
DELAY_MIN = 3
DELAY_MAX = 8

# Timeout de página (ML Venezuela es lento)
PAGE_TIMEOUT = 90000

# Palabras que indican bloqueo/captcha (evitar falsos positivos)
PALABRAS_BLOQUEO = [
    "captcha", "recaptcha", "unusual traffic", "suspicious",
    "blocked", "verifica que no eres", "automation",
    "security check", "account-verification"
]

# Palabras que parecen bloqueo pero son falsos positivos (CSS, fuentes, etc)
PALABRAS_FALSO_POSITIVO = ["roboto", "robot.txt"]

# ══════════════════════════════════════════════════════════════════════════════
# UTILIDADES
# ══════════════════════════════════════════════════════════════════════════════

def log(msg, nivel="INFO"):
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{timestamp}] [{nivel}] {msg}"
    print(line)
    # Guardar log
    log_file = os.path.join(LOG_DIR, f"scraper_log_{datetime.now().strftime('%Y%m%d')}.txt")
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def delay_aleatorio():
    """Delay aleatorio entre 3-8 segundos para parecer humano"""
    segundos = random.uniform(DELAY_MIN, DELAY_MAX)
    log(f"Delay: {segundos:.1f}s...")
    time.sleep(segundos)

def guardar_json(data, filepath):
    """Guardar datos en JSON con timestamp"""
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    log(f"Guardado: {filepath} ({len(data)} items)")

def notificar_telegram(mensaje):
    """Enviar notificación por Telegram (bot ya configurado en el proyecto)"""
    try:
        import requests
        bot_token = "8849065001:AAH3MPEFKHwHvnCQO_oC-i6cmhCtXK2ZFxU"
        chat_id = "6136602706"
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {"chat_id": chat_id, "text": mensaje, "parse_mode": "HTML"}
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        log(f"Error enviando Telegram: {e}", "WARN")

def es_bloqueo(page_content):
    """Detectar si ML nos está bloqueando (con filtro de falsos positivos)"""
    content_lower = page_content.lower()
    
    # Primero verificar falsos positivos
    for falso in PALABRAS_FALSO_POSITIVO:
        if falso in content_lower:
            # Si el "robot" es parte de "Roboto" (fuente CSS), ignorar
            content_lower = content_lower.replace(falso, "")
    
    # Ahora buscar bloqueos reales
    for palabra in PALABRAS_BLOQUEO:
        if palabra in content_lower:
            return True, palabra
    return False, None

def extraer_items(page):
    """Extraer items de una página de resultados de ML"""
    items = []
    
    # Esperar a que carguen los items (ML carga con JS)
    try:
        page.wait_for_selector("li.ui-search-layout__item", timeout=15000)
    except:
        log("No se encontraron items o timeout", "WARN")
        return []
    
    # Scroll para cargar lazy-loaded items
    page.evaluate("window.scrollTo(0, document.body.scrollHeight/2)")
    time.sleep(1)
    page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(1)
    
    elementos = page.query_selector_all("li.ui-search-layout__item")
    log(f"Encontrados {len(elementos)} elementos en página")
    
    for i, el in enumerate(elementos):
        try:
            # Título
            titulo_el = el.query_selector(".ui-search-item__title, h2, [class*='title']")
            titulo = titulo_el.inner_text().strip() if titulo_el else ""
            
            # Precio (limpiar completamente)
            precio_el = el.query_selector(".andes-money-amount__fraction, [class*='price']")
            precio_texto = precio_el.inner_text().strip() if precio_el else ""
            # Limpiar precio: quitar todo excepto números (US$, puntos, comas, espacios)
            precio_limpio = "".join(filter(str.isdigit, precio_texto)) if precio_texto else "0"
            # Si el precio limpio está vacío o es 0, intentar con el atributo aria-label
            if precio_limpio == "0":
                aria = precio_el.get_attribute("aria-label") if precio_el else ""
                if aria:
                    precio_limpio = "".join(filter(str.isdigit, aria))
            
            # Enlace
            link_el = el.query_selector("a.ui-search-link, a[href*='mercadolibre']")
            enlace = link_el.get_attribute("href") if link_el else ""
            
            # Ubicación
            ubicacion_el = el.query_selector(".ui-search-item__location, [class*='location']")
            ubicacion = ubicacion_el.inner_text().strip() if ubicacion_el else ""
            
            # Imagen
            img_el = el.query_selector("img")
            imagen = img_el.get_attribute("src") or img_el.get_attribute("data-src") if img_el else ""
            
            # Tipo de inmueble (del enlace o título)
            tipo = "desconocido"
            if "/casa/" in enlace or "casa" in titulo.lower(): tipo = "casa"
            elif "/apartamento/" in enlace or "apartamento" in titulo.lower(): tipo = "apartamento"
            elif "/terreno/" in enlace or "terreno" in titulo.lower(): tipo = "terreno"
            elif "/local/" in enlace or "local" in titulo.lower(): tipo = "local"
            elif "/oficina/" in enlace or "oficina" in titulo.lower(): tipo = "oficina"
            elif "/galpon/" in enlace or "galpón" in titulo.lower(): tipo = "galpon"
            
            if titulo or precio_limpio != "0":
                items.append({
                    "titulo": titulo,
                    "precio_texto": precio_texto,
                    "precio": int(precio_limpio) if precio_limpio else 0,
                    "enlace": enlace,
                    "ubicacion": ubicacion,
                    "tipo": tipo,
                    "imagen": imagen,
                    "portal": "mercadolibre",
                    "scrapeado_en": datetime.now().isoformat()
                })
                
        except Exception as e:
            log(f"Error extrayendo item {i}: {e}", "WARN")
            continue
    
    return items

def hay_siguiente_pagina(page):
    """Verificar si hay botón de siguiente página"""
    try:
        siguiente = page.query_selector("a.ui-search-pagination__next, .ui-search-pagination__next, [title='Siguiente']")
        return siguiente is not None
    except:
        return False

def ir_siguiente_pagina(page):
    """Navegar a siguiente página de resultados"""
    try:
        siguiente = page.query_selector("a.ui-search-pagination__next, .ui-search-pagination__next, [title='Siguiente']")
        if siguiente:
            siguiente.click()
            return True
    except Exception as e:
        log(f"Error navegando página: {e}", "WARN")
    return False

# ══════════════════════════════════════════════════════════════════════════════
# SCRAPER PRINCIPAL
# ══════════════════════════════════════════════════════════════════════════════

def scrapear_busqueda(busqueda, playwright, browser):
    """Scrapear una búsqueda completa de ML"""
    zona = busqueda["zona"]
    operacion = busqueda["operacion"]
    url_base = busqueda["url"]
    
    log(f"═══ Iniciando: {zona} / {operacion} ═══")
    
    todos_items = []
    pagina_actual = 1
    url_actual = url_base
    
    # Crear nueva pestaña
    page = browser.contexts[0].new_page() if browser.contexts else browser.new_page()
    
    try:
        while True:
            log(f"Página {pagina_actual}: {url_actual[:80]}...")
            
            try:
                # Navegar
                response = page.goto(url_actual, timeout=PAGE_TIMEOUT)
                status = response.status if response else "N/A"
                log(f"HTTP {status}")
                
                if status == 403:
                    log("¡BLOQUEO HTTP 403!", "ERROR")
                    return {"error": "403 Forbidden", "zona": zona, "operacion": operacion}
                
                # Esperar carga completa
                time.sleep(5)
                
                # Verificar bloqueo por contenido
                content = page.content()
                bloqueo, palabra = es_bloqueo(content)
                if bloqueo:
                    log(f"¡BLOQUEO DETECTADO! Palabra: {palabra}", "ERROR")
                    # Screenshot para evidencia
                    screenshot_path = os.path.join(LOG_DIR, f"bloqueo_{zona}_{pagina_actual}.png")
                    page.screenshot(path=screenshot_path)
                    log(f"Screenshot guardado: {screenshot_path}")
                    
                    notificar_telegram(f"⚠️ MercadoLibre bloqueó scraping en {zona} página {pagina_actual}. Revisar manualmente.")
                    return {"error": f"Bloqueo: {palabra}", "zona": zona, "operacion": operacion}
                
                # Extraer items de esta página
                items = extraer_items(page)
                log(f"Extraídos: {len(items)} items")
                todos_items.extend(items)
                
                # Verificar si hay más páginas
                if not hay_siguiente_pagina(page):
                    log("No hay más páginas — fin de resultados")
                    break
                
                # Ir a siguiente página
                log("Navegando a siguiente página...")
                if not ir_siguiente_pagina(page):
                    log("Error navegando, deteniendo", "WARN")
                    break
                
                delay_aleatorio()
                pagina_actual += 1
                
                # Límite de páginas por seguridad (evitar loop infinito)
                if pagina_actual > 50:
                    log("Límite de 50 páginas alcanzado — deteniendo", "WARN")
                    break
                    
            except Exception as e:
                log(f"Error en página {pagina_actual}: {type(e).__name__}: {e}", "ERROR")
                break
        
        # Guardar resultados
        fecha = datetime.now().strftime("%Y-%m-%d")
        filename = f"{zona}-mercadolibre-{fecha}.json"
        filepath = os.path.join(DATA_DIR, filename)
        
        resultado = {
            "zona": zona,
            "portal": "mercadolibre",
            "operacion": operacion,
            "url_busqueda": url_base,
            "paginas_scrapeadas": pagina_actual,
            "total_items": len(todos_items),
            "scrapeado_en": datetime.now().isoformat(),
            "items": todos_items
        }
        
        guardar_json(resultado, filepath)
        log(f"✅ Completado: {zona} {operacion} — {len(todos_items)} items en {pagina_actual} páginas")
        
        return resultado
        
    except Exception as e:
        log(f"Error fatal en {zona}: {e}", "ERROR")
        return {"error": str(e), "zona": zona, "operacion": operacion}
    finally:
        page.close()

def abrir_brave_si_necesario():
    """Abrir Brave con debugging si no está corriendo"""
    try:
        # Verificar si ya está corriendo en el puerto 9222
        import requests
        response = requests.get(f"http://localhost:{DEBUG_PORT}/json/version", timeout=5)
        if response.status_code == 200:
            log("Brave ya está corriendo con debugging")
            return True
    except:
        pass
    
    log("Abriendo Brave con debugging...")
    try:
        subprocess.Popen([BRAVE_PATH, f"--remote-debugging-port={DEBUG_PORT}"])
        time.sleep(5)  # Esperar a que abra
        
        # Verificar
        import requests
        response = requests.get(f"http://localhost:{DEBUG_PORT}/json/version", timeout=10)
        if response.status_code == 200:
            log("Brave abierto correctamente")
            return True
    except Exception as e:
        log(f"Error abriendo Brave: {e}", "ERROR")
    
    return False

def main():
    log("═══════════════════════════════════════════════════════════════")
    log("ARI — Scraper MercadoLibre Local (Playwright + Brave)")
    log("═══════════════════════════════════════════════════════════════")
    
    # Verificar directorios
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    
    # Cargar configuración
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        config = json.load(f)
    
    # Filtrar solo búsquedas de MercadoLibre
    busquedas_ml = [b for b in config["busquedas"] if b["portal"] == "mercadolibre"]
    
    if not busquedas_ml:
        log("No hay búsquedas de MercadoLibre configuradas en busquedas.json", "ERROR")
        log("Agregar URLs de ML al archivo de configuración", "ERROR")
        return
    
    log(f"Se encontraron {len(busquedas_ml)} búsquedas de MercadoLibre")
    
    # Abrir Brave si necesario
    if not abrir_brave_si_necesario():
        log("No se pudo abrir Brave. Ejecutar manualmente:", "ERROR")
        log(f'  "{BRAVE_PATH}" --remote-debugging-port={DEBUG_PORT}', "ERROR")
        return
    
    # Conectar Playwright
    with sync_playwright() as p:
        try:
            browser = p.chromium.connect_over_cdp(f"http://localhost:{DEBUG_PORT}")
            log(f"Conectado a Brave v{browser.version}")
            
            # Procesar cada búsqueda
            resultados = []
            for busqueda in busquedas_ml:
                resultado = scrapear_busqueda(busqueda, p, browser)
                resultados.append(resultado)
                
                # Delay entre búsquedas diferentes
                delay_aleatorio()
                delay_aleatorio()  # Doble delay entre búsquedas
            
            # Resumen final
            log("═══════════════════════════════════════════════════════════════")
            log("RESUMEN FINAL")
            log("═══════════════════════════════════════════════════════════════")
            
            total_items = sum(r.get("total_items", 0) for r in resultados if "error" not in r)
            exitosos = sum(1 for r in resultados if "error" not in r)
            fallidos = len(resultados) - exitosos
            
            log(f"Total items scrapeados: {total_items}")
            log(f"Búsquedas exitosas: {exitosos}")
            log(f"Búsquedas fallidas: {fallidos}")
            
            # Notificación Telegram
            mensaje = f"✅ <b>ARI Scraper ML completado</b>\n\n"
            mensaje += f"📊 Total items: {total_items}\n"
            mensaje += f"✅ Exitosas: {exitosos}\n"
            mensaje += f"❌ Fallidas: {fallidos}\n"
            if fallidos > 0:
                mensaje += "\n⚠️ Revisar logs en: " + LOG_DIR
            notificar_telegram(mensaje)
            
        except Exception as e:
            log(f"Error conectando a Brave: {e}", "ERROR")
            notificar_telegram(f"❌ Error conectando a Brave: {e}")

if __name__ == "__main__":
    main()
