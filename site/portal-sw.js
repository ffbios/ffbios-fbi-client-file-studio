const CACHE_NAME="fbi-client-file-studio-portal-v2";
const APP_SHELL=["/portal","/portal-manifest.webmanifest","/official-logo.png?v=3","/portal-pwa-icon-192.png","/portal-pwa-icon-512.png"];

self.addEventListener("install",event=>{
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache=>cache.addAll(APP_SHELL.map(url=>new Request(url,{cache:"reload"}))))
      .catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(k=>k!==CACHE_NAME).map(k=>caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener("push",event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch(e){data={title:"FBI Creative Portal",body:event.data?event.data.text():""}}
  const title=data.title||"FBI Creative Portal";
  const options={
    body:data.body||"A new update is available.",
    icon:"/official-logo.png?v=3",
    badge:"/official-logo.png?v=3",
    tag:data.tag||"fbi-update",
    renotify:true,
    data:{url:data.url||"/portal"}
  };
  event.waitUntil(self.registration.showNotification(title,options));
});

self.addEventListener("notificationclick",event=>{
  event.notification.close();
  const target=(event.notification.data&&event.notification.data.url)||"/portal";
  event.waitUntil((async()=>{
    const all=await clients.matchAll({type:"window",includeUncontrolled:true});
    for(const c of all){
      if(c.url.includes("/portal")&&"focus"in c){try{await c.navigate(target)}catch(e){}return c.focus();}
    }
    return clients.openWindow(target);
  })());
});

self.addEventListener("fetch",event=>{
  const req=event.request;
  const url=new URL(req.url);
  if(req.method!=="GET" || url.origin!==self.location.origin)return;

  // Never cache API responses or uploaded/downloaded media.
  if(url.pathname.startsWith("/api/") || url.pathname.startsWith("/share/") || url.pathname.startsWith("/watch/"))return;

  event.respondWith((async()=>{
    if(req.mode==="navigate" || url.pathname==="/portal" || url.pathname==="/portal/"){
      try{
        const fresh=await fetch(req,{cache:"no-store"});
        const copy=fresh.clone();
        if(fresh.ok){
          const cache=await caches.open(CACHE_NAME);
          await cache.put("/portal",copy);
        }
        return fresh;
      }catch{
        return (await caches.match("/portal")) || (await caches.match("/")) || Response.error();
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
