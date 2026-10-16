const V="arg-cap-v7",A=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png"];
self.addEventListener("install",e=>e.waitUntil((async()=>{const c=await caches.open(V);await Promise.allSettled(A.map(u=>c.add(u)));await self.skipWaiting()})()));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
// Red primero (siempre la versión nueva si hay señal); sin señal, lo guardado en caché
self.addEventListener("fetch",e=>{
  if(e.request.method!=="GET"||new URL(e.request.url).origin!==location.origin)return;
  e.respondWith(fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(V).then(c=>c.put(e.request,cp))}return r})
    .catch(()=>caches.match(e.request,{ignoreSearch:true}).then(m=>m||caches.match("./index.html"))))});
