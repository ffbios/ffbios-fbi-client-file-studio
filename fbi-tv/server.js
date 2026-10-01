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
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:false});

function uid(){return crypto.randomUUID()}
function token(n=24){return crypto.randomBytes(n).toString("base64url")}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function normalizeEmail(v){return String(v||"").trim().toLowerCase()}
function normalizeAnswer(v){return String(v||"").trim().toLowerCase().replace(/\s+/g," ")}
function passwordHash(password){
  const salt=crypto.randomBytes(16).toString("hex");
  const hash=crypto.scryptSync(String(password),salt,64).toString("hex");
  return salt+"$"+hash;
}
function passwordVerify(password,stored){
  try{
    const [salt,hex]=String(stored||"").split("$");
    if(!salt||!hex)return false;
    const actual=crypto.scryptSync(String(password),salt,64);
    const expected=Buffer.from(hex,"hex");
    return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);
  }catch{return false}
}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function signPayload(payload,purpose){
  const body=Buffer.from(JSON.stringify({...payload,purpose})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(body).digest("base64url");
  return body+"."+sig;
}
function readSigned(value,purpose){
  const [body,sig]=String(value||"").split(".");
  if(!body||!sig)return null;
  try{
    const expected=crypto.createHmac("sha256",SESSION_SECRET).update(body).digest("base64url");
    if(sig.length!==expected.length||!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    const d=JSON.parse(Buffer.from(body,"base64url").toString("utf8"));
    if(d.purpose!==purpose||Number(d.exp)<=Date.now())return null;
    return d;
  }catch{return null}
}
function signSession(user){return signPayload({uid:user.id,email:user.email,exp:Date.now()+7*86400000},"session")}
function signReset(user){return signPayload({uid:user.id,email:user.email,exp:Date.now()+10*60*1000,nonce:crypto.randomBytes(12).toString("hex")},"reset")}
function setSession(res,user){res.setHeader("Set-Cookie","fbi_tv_session="+encodeURIComponent(signSession(user))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800")}
function clearSession(res){res.setHeader("Set-Cookie","fbi_tv_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0")}
async function sessionUser(req){
  const d=readSigned(cookies(req).fbi_tv_session,"session");
  if(!d?.uid)return null;
  const q=await pool.query("SELECT id,full_name,email,role,active FROM tv_admin_users WHERE id=$1 AND active=true",[d.uid]);
  return q.rows[0]||null;
}
async function admin(req,res,next){
  try{
    const user=await sessionUser(req);
    if(!user)return res.status(401).json({error:"Unauthorised"});
    req.adminUser=user;
    next();
  }catch(e){
    console.error("Auth middleware failed:",e);
    res.status(500).json({error:"Authentication service unavailable"});
  }
}
const SECURITY_QUESTIONS=[
  "What was the name of your first school?",
  "What city or town were you born in?",
  "What was your childhood nickname?",
  "What was the name of your first pet?",
  "What was your favourite food growing up?",
  "What was the name of your favourite teacher?"
]
function esc(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
async function init(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tv_admin_users(
      id uuid PRIMARY KEY,
      full_name text NOT NULL,
      email text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      q1 text NOT NULL,
      a1_hash text NOT NULL,
      q2 text NOT NULL,
      a2_hash text NOT NULL,
      q3 text NOT NULL,
      a3_hash text NOT NULL,
      role text NOT NULL DEFAULT 'admin',
      active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_login timestamptz
    );
    CREATE INDEX IF NOT EXISTS idx_tv_admin_users_email ON tv_admin_users(email);
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
  return RTMP_HOST?"rtmp://"+RTMP_HOST+":"+RTMP_PORT+"/live":"";
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

app.get("/api/auth/status",async(req,res)=>{
  try{
    const q=await pool.query("SELECT count(*)::int AS count FROM tv_admin_users WHERE active=true");
    res.json({hasAdmin:Number(q.rows[0]?.count||0)>0,securityQuestions:SECURITY_QUESTIONS});
  }catch(e){res.status(500).json({error:"Could not load account status"})}
});
app.post("/api/auth/register",async(req,res)=>{
  try{
    const fullName=String(req.body.fullName||"").trim();
    const email=normalizeEmail(req.body.email);
    const password=String(req.body.password||"");
    const confirm=String(req.body.confirmPassword||"");
    const questions=Array.isArray(req.body.questions)?req.body.questions:[];
    const answers=Array.isArray(req.body.answers)?req.body.answers:[];
    if(fullName.length<2)return res.status(400).json({error:"Enter the administrator's full name."});
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))return res.status(400).json({error:"Enter a valid email address."});
    if(password.length<10)return res.status(400).json({error:"Password must be at least 10 characters."});
    if(password!==confirm)return res.status(400).json({error:"Passwords do not match."});
    if(questions.length!==3||answers.length!==3)return res.status(400).json({error:"Choose and answer all three security questions."});
    if(new Set(questions).size!==3||questions.some(q=>!SECURITY_QUESTIONS.includes(String(q))))return res.status(400).json({error:"Choose three different security questions."});
    if(answers.some(a=>normalizeAnswer(a).length<2))return res.status(400).json({error:"Each security answer must contain at least 2 characters."});
    const count=await pool.query("SELECT count(*)::int AS count FROM tv_admin_users WHERE active=true");
    if(Number(count.rows[0]?.count||0)>0)return res.status(403).json({error:"An administrator already exists. Ask an existing administrator to add another account."});
    const id=uid();
    const q=await pool.query("INSERT INTO tv_admin_users(id,full_name,email,password_hash,q1,a1_hash,q2,a2_hash,q3,a3_hash,role) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'admin') RETURNING id,full_name,email,role",
      [id,fullName,email,passwordHash(password),questions[0],passwordHash(normalizeAnswer(answers[0])),questions[1],passwordHash(normalizeAnswer(answers[1])),questions[2],passwordHash(normalizeAnswer(answers[2]))]);
    const user=q.rows[0];
    setSession(res,user);
    res.status(201).json({ok:true,user});
  }catch(e){
    if(e?.code==="23505")return res.status(409).json({error:"An account with that email already exists."});
    console.error("Admin registration failed:",e);
    res.status(500).json({error:"Could not create administrator account."});
  }
});
app.post("/api/auth/login",async(req,res)=>{
  try{
    const email=normalizeEmail(req.body.email);
    const password=String(req.body.password||"");
    const q=await pool.query("SELECT * FROM tv_admin_users WHERE email=$1 AND active=true LIMIT 1",[email]);
    const user=q.rows[0];
    if(!user||!passwordVerify(password,user.password_hash))return res.status(401).json({error:"Invalid email or password."});
    await pool.query("UPDATE tv_admin_users SET last_login=now() WHERE id=$1",[user.id]);
    setSession(res,user);
    res.json({ok:true,user:{id:user.id,full_name:user.full_name,email:user.email,role:user.role}});
  }catch(e){console.error("Login failed:",e);res.status(500).json({error:"Could not sign in."})}
});
app.post("/api/auth/forgot/start",async(req,res)=>{
  try{
    const email=normalizeEmail(req.body.email);
    const q=await pool.query("SELECT id,email,q1,q2,q3 FROM tv_admin_users WHERE email=$1 AND active=true LIMIT 1",[email]);
    if(!q.rowCount)return res.status(404).json({error:"No active FBI TV administrator account was found for that email."});
    const u=q.rows[0];
    res.json({ok:true,resetToken:signReset(u),questions:[u.q1,u.q2,u.q3]});
  }catch(e){console.error("Password recovery start failed:",e);res.status(500).json({error:"Could not start password recovery."})}
});
app.post("/api/auth/forgot/reset",async(req,res)=>{
  try{
    const d=readSigned(req.body.resetToken,"reset");
    if(!d?.uid)return res.status(400).json({error:"This password recovery session has expired. Start again."});
    const answers=Array.isArray(req.body.answers)?req.body.answers:[];
    const password=String(req.body.password||"");
    const confirm=String(req.body.confirmPassword||"");
    if(answers.length!==3)return res.status(400).json({error:"Answer all three security questions."});
    if(password.length<10)return res.status(400).json({error:"New password must be at least 10 characters."});
    if(password!==confirm)return res.status(400).json({error:"Passwords do not match."});
    const q=await pool.query("SELECT id,email,q1,a1_hash,q2,a2_hash,q3,a3_hash,full_name,role FROM tv_admin_users WHERE id=$1 AND active=true LIMIT 1",[d.uid]);
    if(!q.rowCount)return res.status(400).json({error:"Administrator account not found."});
    const u=q.rows[0];
    const ok=[
      passwordVerify(normalizeAnswer(answers[0]),u.a1_hash),
      passwordVerify(normalizeAnswer(answers[1]),u.a2_hash),
      passwordVerify(normalizeAnswer(answers[2]),u.a3_hash)
    ].every(Boolean);
    if(!ok)return res.status(401).json({error:"One or more security answers are incorrect."});
    await pool.query("UPDATE tv_admin_users SET password_hash=$1 WHERE id=$2",[passwordHash(password),u.id]);
    const user={id:u.id,email:u.email,full_name:u.full_name,role:u.role};
    setSession(res,user);
    res.json({ok:true,user});
  }catch(e){console.error("Password reset failed:",e);res.status(500).json({error:"Could not reset the password."})}
});
app.get("/api/auth/me",async(req,res)=>{
  try{
    const user=await sessionUser(req);
    res.json({authenticated:!!user,user:user||null});
  }catch(e){res.status(500).json({error:"Could not verify session"})}
});
app.post("/api/auth/logout",(req,res)=>{clearSession(res);res.json({ok:true})});

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
  let live=String(s.status||"offline")==="live";
  if(MEDIA_BASE){
    try{
      const probe=await fetch(MEDIA_BASE+"/live/"+encodeURIComponent(s.stream_key)+"/index.m3u8",{cache:"no-store"});
      const actual=probe.ok;
      if(actual!==live){
        await pool.query("UPDATE tv_streams SET status=$1,updated_at=now() WHERE id=$2",[actual?"live":"offline",s.id]);
        live=actual;
      }
    }catch(_e){}
  }
  res.json({live,title:s.title,name:s.name,current_viewers:Number(s.current_viewers||0),hls_url:hlsProxyBase(req.params.token)});
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

app.get("/live/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT id FROM tv_streams WHERE id=$1 AND enabled=true",[req.params.id]);
    if(!q.rowCount)return res.status(404).send("Live stream not found.");
    res.redirect(302,"/?stream="+encodeURIComponent(q.rows[0].id));
  }catch(e){
    console.error("Live studio route failed:",e);
    res.status(500).send("Could not open live stream.");
  }
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
