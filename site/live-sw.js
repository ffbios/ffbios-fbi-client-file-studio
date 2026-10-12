const CACHE_PREFIX="fbi-live-pwa-";
const CACHE_NAME=CACHE_PREFIX+"v8";
const SHELL=["/","/manifest.webmanifest?live=v7","/official-logo.png","/live-pwa-icon-192.png","/live-pwa-icon-512.png"];

self.addEventListener("install",event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(SHELL)));
  self.skipWaiting();
});
self.addEventListener("activate",event=>{
  // Only remove this app's own old caches; other apps on this domain
  // (the /tv watch app, the portal) keep theirs.
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(k=>k!==CACHE_NAME&&(k.startsWith(CACHE_PREFIX)||k.startsWith("fbi-client-file-studio-"))).map(k=>caches.delete(k))
  )));
  self.clients.claim();
});
self.addEventListener("fetch",event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.method!=="GET"||url.origin!==self.location.origin)return;
  if(url.pathname.startsWith("/api/"))return;
  if(url.pathname.startsWith("/watch/")||url.pathname.startsWith("/share/"))return;
  if(url.pathname==="/tv"||url.pathname.startsWith("/tv/")||url.pathname.startsWith("/tv-"))return;
  event.respondWith((async()=>{
    if(req.mode==="navigate"){
      // Network first. Each page is cached under its own address, so an
      // offline fallback never shows a different page than the one asked for.
      const key=url.pathname;
      try{
        const fresh=await fetch(req,{cache:"no-store"});
        if(fresh.ok){
          const cache=await caches.open(CACHE_NAME);
          await cache.put(key,fresh.clone());
        }
        return fresh;
      }catch{
        return (await caches.match(key))||(await caches.match("/"))||Response.error();
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
