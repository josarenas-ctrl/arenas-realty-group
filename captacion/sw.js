const V="arg-cap-v5",A=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png"];
self.addEventListener("install",e=>e.waitUntil((async()=>{const c=await caches.open(V);await Promise.allSettled(A.map(u=>c.add(u)));await self.skipWaiting()})()));
self.addEventListener("activate",e=>e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!=V).map(x=>caches.delete(x)))).then(()=>self.clients.claim())));
self.addEventListener("fetch",e=>{if(e.request.method!="GET"||new URL(e.request.url).origin!=location.origin)return;
e.respondWith(caches.open(V).then(async c=>{const m=await c.match(e.request,{ignoreSearch:true});const n=fetch(e.request).then(r=>{if(r.ok)c.put(e.request,r.clone());return r}).catch(()=>m||c.match("./index.html"));return m||n}))});
