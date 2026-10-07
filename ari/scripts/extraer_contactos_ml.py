# ARI — Extracción de contactos MercadoLibre
# Prueba de 500 items (Miranda Venta)
# 
# Uso: python extraer_contactos_ml.py [archivo.json] [--max N]

import json
import os
import re
import time
import sys
from playwright.sync_api import sync_playwright

DATA_DIR = r"C:\Users\ASISTENTE\arenas-realty-group\ari\data"
TEMP_DIR = r"C:\Users\ASISTENTE\temp-ml-scraper"

def extraer_contacto(page, url, context):
    """Entrar a página individual y extraer teléfono via botón Contactar → WhatsApp"""
    try:
        page.goto(url, timeout=30000)
        time.sleep(3)
        
        telefono = ""
        email = ""
        
        # Buscar botón "Contactar" que lleva a WhatsApp
        try:
            # Buscar botón WhatsApp específico
            boton = page.query_selector('button:has-text("WhatsApp")')
            
            if boton:
                # Hacer clic y capturar popup
                with context.expect_page() as new_page_info:
                    boton.click()
                
                popup = new_page_info.value
                
                # Esperar solo a que tenga URL wa.me
                for _ in range(20):
                    if popup.url and "wa.me" in popup.url:
                        break
                    time.sleep(0.5)
                
                # Extraer número de URL
                match = re.search(r'(?:wa\.me|phone=)(\d+)', popup.url)
                if match:
                    telefono = match.group(1)
                
                popup.close()
        except Exception as e:
            print(f"    Error con botón WhatsApp: {e}")
        
        # Buscar email en contenido (si existe)
        contenido = page.content()
        email_match = re.search(r'([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})', contenido)
        if email_match and "ejemplo" not in email_match.group(1).lower():
            email = email_match.group(1)
        
        return {"telefono": telefono, "email": email, "exito": bool(telefono or email)}
        
    except Exception as e:
        return {"telefono": "", "email": "", "exito": False, "error": str(e)}

def main():
    # Argumentos
    archivo = "miranda-mercadolibre-2026-10-04.json"
    max_items = 500
    
    # Parsear argumentos: primero archivo, luego opciones
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = {a: sys.argv[sys.argv.index(a)+1] for i, a in enumerate(sys.argv) if a.startswith("--") and i+1 < len(sys.argv)}
    
    if args:
        archivo = args[0]
    if "--max" in opts:
        max_items = int(opts["--max"])
    
    filepath = os.path.join(DATA_DIR, archivo)
    if not os.path.exists(filepath):
        print(f"Error: No existe {filepath}")
        return
    
    print(f"=== PRUEBA: Extracción de contactos ML ===")
    print(f"Archivo: {archivo}")
    print(f"Máximo: {max_items} items")
    print()
    
    # Cargar datos
    with open(filepath, "r", encoding="utf-8") as f:
        data = json.load(f)
    
    items = data.get("items", [])[:max_items]
    print(f"Items a procesar: {len(items)}")
    
    resultados = []
    exitosos = 0
    inicio = time.time()
    
    with sync_playwright() as p:
        # Usar Chromium propio (sin Brave) para evitar conflictos
        print("  Iniciando Chromium propio...")
        context = p.chromium.launch_persistent_context(
            user_data_dir=r"C:\Users\ASISTENTE\temp-ml-scraper\chromium-profile",
            headless=False,
            args=["--remote-debugging-port=9222"]
        )
        print("  Chromium iniciado")
    
        page = context.new_page()
        
        for i, item in enumerate(items, 1):
            print(f"\n[{i}/{len(items)}] {item.get('titulo', 'N/A')[:50]}...")
            
            contacto = extraer_contacto(page, item.get("enlace", ""), context)
            item["contacto"] = contacto
            resultados.append(item)
            
            if contacto["exito"]:
                exitosos += 1
                print(f"  ✓ Tel: {contacto['telefono']} | Email: {contacto['email']}")
            else:
                print(f"  ✗ Sin contacto")
            
            # Guardar progreso cada 50
            if i % 50 == 0:
                temp_file = filepath.replace(".json", f"-progreso-{i}.json")
                with open(temp_file, "w", encoding="utf-8") as f:
                    json.dump(resultados, f, ensure_ascii=False, indent=2)
                print(f"  💾 Progreso guardado ({i}/{len(items)})")
            
            # Delay anti-detección
            time.sleep(5)
    
    # Guardar final
    output_file = filepath.replace(".json", "-con-contactos.json")
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(resultados, f, ensure_ascii=False, indent=2)
    
    print(f"\n{'='*50}")
    print(f"✅ PRUEBA COMPLETADA")
    print(f"{'='*50}")
    duracion = time.time() - inicio
    promedio = duracion / len(resultados) if resultados else 0
    print(f"Total procesados: {len(resultados)}")
    print(f"Con contacto: {exitosos} ({exitosos/len(resultados)*100:.1f}%)")
    print(f"Sin contacto: {len(resultados)-exitosos}")
    print(f"Tiempo total: {duracion:.1f}s ({duracion/60:.1f} min)")
    print(f"Tiempo por contacto: {promedio:.1f}s")
    print(f"Estimado 12,000 items: {promedio*12000/3600:.1f} horas")
    print(f"Archivo: {output_file}")

if __name__ == "__main__":
    main()
