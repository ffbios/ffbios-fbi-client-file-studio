const CACHE_NAME="fbi-live-pwa-v3";
const SHELL=["/","/manifest.webmanifest","/official-logo.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate",event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
  )));
  self.clients.claim();
});
self.addEventListener("fetch",event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.method!=="GET"||url.origin!==self.location.origin)return;
  if(url.pathname.startsWith("/api/"))return;
  if(url.pathname.startsWith("/watch/")||url.pathname.startsWith("/share/"))return;
  event.respondWith((async()=>{
    if(req.mode==="navigate"){
      try{
        const fresh=await fetch(req,{cache:"no-store"});
        const copy=fresh.clone();
        const cache=await caches.open(CACHE_NAME);
        await cache.put("/",copy);
        return fresh;
      }catch{
        return (await caches.match("/"))||Response.error();
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
    }catch{return Response.error()}
  })());
});