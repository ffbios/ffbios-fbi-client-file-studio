const CACHE_NAME="fbi-client-file-studio-v1";
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
  if(req.method!=="GET") return;

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
    if(cached) return cached;

    try{
      const fresh=await fetch(req);
      if(new URL(req.url).origin===self.location.origin){
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