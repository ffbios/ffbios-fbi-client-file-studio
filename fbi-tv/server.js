const express=require("express");
const crypto=require("crypto");
const path=require("path");
const {Pool}=require("pg");

const app=express();
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:true}));
const PORT=Number(process.env.PORT||8080);
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const MEDIA_BASE=(process.env.MEDIA_BASE_URL||"").replace(/\/+$/,"");
const RTMP_HOST=process.env.RTMP_HOST||"";
const RTMP_PORT=Number(process.env.RTMP_PORT||1935);
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});

function uid(){return crypto.randomUUID()}
function token(n=24){return crypto.randomBytes(n).toString("base64url")}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function signSession(email){
  const exp=Date.now()+7*86400000;
  const payload=Buffer.from(JSON.stringify({email,exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validSession(req){
  const s=cookies(req).fbi_tv_session;if(!s)return false;
  const [payload,sig]=s.split(".");if(!payload||!sig)return false;
  try{
    const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
    if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
    const d=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return d.email===ADMIN_EMAIL&&Number(d.exp)>Date.now();
  }catch{return false}
}
function admin(req,res,next){if(!validSession(req))return res.status(401).json({error:"Unauthorised"});next()}
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tv_streams(
      id uuid PRIMARY KEY,
      name text NOT NULL,
      title text NOT NULL DEFAULT '',
      description text NOT NULL DEFAULT '',
      stream_key text UNIQUE NOT NULL,
      viewer_token text UNIQUE NOT NULL,
      enabled boolean NOT NULL DEFAULT true,
      shared boolean NOT NULL DEFAULT true,
      record_enabled boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'offline',
      current_viewers integer NOT NULL DEFAULT 0,
      total_viewers integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_tv_streams_updated ON tv_streams(updated_at DESC);
  `);
}
function rtmpServer(){
  return RTMP_HOST?\`rtmp://\${RTMP_HOST}:\${RTMP_PORT}/live\`:"";
}
function hlsForKey(key){
  return MEDIA_BASE?MEDIA_BASE+"/live/"+encodeURIComponent(key)+"/index.m3u8":"";
}
function hlsProxyBase(tokenValue){
  return "/api/public/watch/"+encodeURIComponent(tokenValue)+"/hls/";
}
async function publicStream(tokenValue){
  const q=await pool.query("SELECT * FROM tv_streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[tokenValue]);
  return q.rows[0]||null;
}

app.post("/api/auth/login",async(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(!ADMIN_PASSWORD||email!==ADMIN_EMAIL||password!==ADMIN_PASSWORD)return res.status(401).json({error:"Invalid login"});
  res.setHeader("Set-Cookie","fbi_tv_session="+encodeURIComponent(signSession(email))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800");
  res.json({ok:true});
});
app.get("/api/auth/me",(req,res)=>res.json({authenticated:validSession(req),email:validSession(req)?ADMIN_EMAIL:null}));
app.post("/api/auth/logout",(req,res)=>{res.setHeader("Set-Cookie","fbi_tv_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");res.json({ok:true})});

app.get("/api/streams",admin,async(req,res)=>{
  const q=await pool.query("SELECT * FROM tv_streams ORDER BY updated_at DESC");
  res.json({streams:q.rows.map(s=>({
    id:s.id,name:s.name,title:s.title,description:s.description,stream_key:s.stream_key,
    status:s.status,shared:s.shared,record_enabled:s.record_enabled,current_viewers:s.current_viewers,total_viewers:s.total_viewers,
    rtmp_server:rtmpServer(),viewer_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token
  }))});
});
app.post("/api/streams",admin,async(req,res)=>{
  const name=String(req.body.name||"").trim();
  if(!name)return res.status(400).json({error:"Stream name is required"});
  const s={
    id:uid(),name,title:String(req.body.title||name).trim(),description:String(req.body.description||"").trim(),
    stream_key:token(18),viewer_token:token(24)
  };
  const q=await pool.query("INSERT INTO tv_streams(id,name,title,description,stream_key,viewer_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[s.id,s.name,s.title,s.description,s.stream_key,s.viewer_token]);
  const row=q.rows[0];
  res.status(201).json({stream:{...row,rtmp_server:rtmpServer(),viewer_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+row.viewer_token}});
});
app.get("/api/streams/:id",admin,async(req,res)=>{
  const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1",[req.params.id]);if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
  const s=q.rows[0];res.json({stream:{...s,rtmp_server:rtmpServer(),viewer_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token}});
});
app.patch("/api/streams/:id",admin,async(req,res)=>{
  const fields=[],vals=[];for(const k of ["name","title","description","shared","record_enabled","enabled"]){if(req.body[k]!==undefined){vals.push(req.body[k]);fields.push(k+"=$"+vals.length)}}
  if(!fields.length)return res.status(400).json({error:"Nothing to update"});
  vals.push(req.params.id);const q=await pool.query(`UPDATE tv_streams SET ${fields.join(",")},updated_at=now() WHERE id=$${vals.length} RETURNING *`,vals);
  if(!q.rowCount)return res.status(404).json({error:"Stream not found"});const s=q.rows[0];
  res.json({stream:{...s,rtmp_server:rtmpServer(),viewer_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token}});
});
app.post("/api/streams/:id/regenerate-key",admin,async(req,res)=>{
  const key=token(18);const q=await pool.query("UPDATE tv_streams SET stream_key=$1,status='offline',updated_at=now() WHERE id=$2 RETURNING *",[key,req.params.id]);
  if(!q.rowCount)return res.status(404).json({error:"Stream not found"});const s=q.rows[0];
  res.json({stream:{...s,rtmp_server:rtmpServer(),viewer_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token}});
});
app.delete("/api/streams/:id",admin,async(req,res)=>{const q=await pool.query("DELETE FROM tv_streams WHERE id=$1 RETURNING id",[req.params.id]);if(!q.rowCount)return res.status(404).json({error:"Stream not found"});res.json({ok:true})});

app.post("/api/mediamtx/auth",async(req,res)=>{
  const action=String(req.body.action||"");
  const pathValue=String(req.body.path||"");
  const key=pathValue.split("/").filter(Boolean).pop()||"";
  if(action==="publish"){
    const q=await pool.query("SELECT id FROM tv_streams WHERE stream_key=$1 AND enabled=true",[key]);
    if(!q.rowCount)return res.status(401).end();
    await pool.query("UPDATE tv_streams SET status='live',updated_at=now() WHERE id=$1",[q.rows[0].id]);
    return res.status(200).end();
  }
  if(action==="read"){
    const q=await pool.query("SELECT id FROM tv_streams WHERE stream_key=$1 AND enabled=true AND shared=true",[key]);
    if(q.rowCount)return res.status(200).end();
    return res.status(401).end();
  }
  return res.status(401).end();
});

app.get("/api/public/watch/:token/status",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).json({error:"Watch link is invalid or disabled."});
  const rtmpPath=s.stream_key;
  const fresh=String(s.status||"offline");
  res.json({live:fresh==="live",title:s.title,name:s.name,current_viewers:Number(s.current_viewers||0),hls_url:hlsProxyBase(req.params.token)});
});
app.get("/api/public/watch/:token/hls/:file",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).end();
  if(!MEDIA_BASE)return res.status(503).end();
  const target=MEDIA_BASE+"/live/"+encodeURIComponent(s.stream_key)+"/"+req.params.file;
  try{
    const upstream=await fetch(target);
    if(!upstream.ok)return res.status(upstream.status).end();
    const type=upstream.headers.get("content-type")||"application/octet-stream";
    const body=await upstream.text();
    if(/mpegurl|vnd\.apple\.mpegurl/i.test(type)){
      const base="/api/public/watch/"+encodeURIComponent(req.params.token)+"/hls/";
      const rewritten=body.split("\n").map(line=>{
        const t=line.trim();if(!t||t.startsWith("#"))return line;
        if(/^https?:\/\//i.test(t))return t.replace(MEDIA_BASE,base);
        return base+t;
      }).join("\n");
      res.setHeader("Content-Type",type);return res.send(rewritten);
    }
    res.setHeader("Content-Type",type);return res.send(body);
  }catch(e){res.status(502).end()}
});

// generic HLS asset proxy for segment paths such as .m4s or .ts
app.get("/api/public/watch/:token/hls/*asset",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s||!MEDIA_BASE)return res.status(404).end();
  const asset=Array.isArray(req.params.asset)?req.params.asset.join("/") : String(req.params.asset||"");
  const target=MEDIA_BASE+"/live/"+encodeURIComponent(s.stream_key)+"/"+asset;
  try{
    const upstream=await fetch(target);
    if(!upstream.ok)return res.status(upstream.status).end();
    const ab=Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type",upstream.headers.get("content-type")||"application/octet-stream");
    res.send(ab);
  }catch(e){res.status(502).end()}
});

app.post("/api/public/watch/:token/heartbeat",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).end();
  await pool.query("UPDATE tv_streams SET current_viewers=GREATEST(0,current_viewers+0),total_viewers=GREATEST(total_viewers,0),updated_at=now() WHERE id=$1",[s.id]);
  res.json({ok:true});
});

app.get("/watch/:token",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).send("Watch link is invalid or disabled.");
  const title=esc(s.title||s.name), tvBase=process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} • FBI TV</title><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><style>
body{margin:0;background:#09090a;color:#f6f6f7;font-family:Inter,system-ui,sans-serif}.wrap{max-width:1200px;margin:auto;padding:24px}.brand{color:#e8c448;font-size:12px;letter-spacing:.16em;text-transform:uppercase}.title{font-size:28px;font-weight:800;margin:8px 0}.meta{color:#9b9ba4;font-size:12px;margin-bottom:16px}.player{background:#000;border:1px solid #26262a;border-radius:18px;overflow:hidden}.player video{width:100%;display:block;aspect-ratio:16/9;background:#000}.offline{min-height:420px;display:grid;place-items:center;color:#aaa;text-align:center;padding:20px}.foot{color:#666;font-size:10px;text-align:center;padding:18px}</style></head><body><div class="wrap"><div class="brand">FILM BEYOND IMAGINATION • FBI TV</div><div class="title">${title}</div><div class="meta" id="meta">Checking live status…</div><div class="player"><video id="video" controls playsinline autoplay muted></video><div id="offline" class="offline" style="display:none">Waiting for the broadcast to start…</div></div><div class="foot">FBI TV • Live broadcast</div></div><script>
const token=${JSON.stringify(req.params.token)},video=document.getElementById("video"),offline=document.getElementById("offline"),meta=document.getElementById("meta");let player=null,live=false;
function stop(){if(player){try{player.destroy()}catch{}player=null}video.pause();video.removeAttribute("src");video.load()}
function start(url){stop();video.style.display="block";offline.style.display="none";if(window.Hls&&Hls.isSupported()){player=new Hls({enableWorker:true,lowLatencyMode:false,liveSyncDurationCount:3,liveMaxLatencyDurationCount:6,maxBufferLength:30,maxMaxBufferLength:60,backBufferLength:90});player.on(Hls.Events.ERROR,(_,d)=>{if(d&&d.fatal){setTimeout(()=>{if(live)start(url)},1800)}});player.loadSource(url);player.attachMedia(video);player.on(Hls.Events.MANIFEST_PARSED,()=>video.play().catch(()=>{}));return}video.src=url;video.play().catch(()=>{})}
async function refresh(){try{const r=await fetch("/api/public/watch/"+encodeURIComponent(token)+"/status",{cache:"no-store"}),d=await r.json();if(!r.ok)throw new Error(d.error);meta.textContent=d.live?"● LIVE":"OFFLINE";if(d.live){if(!live){live=true;start(d.hls_url+"index.m3u8")} }else{if(live){live=false;stop()}video.style.display="none";offline.style.display="grid"}}catch(e){meta.textContent="STREAM UNAVAILABLE"}}
refresh();setInterval(refresh,8000);
</script></body></html>`);
});

const index=path.join(__dirname,"public/index.html");
app.use(express.static(path.join(__dirname,"public")));
app.get("/",(req,res)=>res.sendFile(index));
init().then(()=>app.listen(PORT,()=>console.log("FBI TV Control listening on port "+PORT))).catch(e=>{console.error(e);process.exit(1)});
