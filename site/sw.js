const CACHE_NAME="fbi-client-file-studio-v6";
const APP_SHELL=["/","/manifest.webmanifest","/pwa-icon.svg"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.method!=="GET" || url.origin!==self.location.origin) return;
  if(url.pathname==="/editor.html") return;
  if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/watch/") || url.pathname.startsWith("/share/")) return;

  event.respondWith((async()=>{
    if(req.mode==="navigate"){
      try{
        const fresh=await fetch(req);
        const copy=fresh.clone();
        const cache=await caches.open(CACHE_NAME);
        await cache.put("/",copy);
        return fresh;
      }catch{
        return (await caches.match("/")) || Response.error();
      }
    }
    const cached=await caches.match(req);
    if(cached)return cached;
    try{
      const fresh=await fetch(req);
      if(fresh.ok){
        const copy=fresh.clone();
        const cache=await caches.open(CACHE_NAME);
        await cache.put(req,copy);
      }
      return fresh;
    }catch{
      return Response.error();
    }
  })());
});