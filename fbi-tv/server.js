const express=require("express");
const http=require("http");
const {attachBrowserIngest}=require("./browser-ingest");
const crypto=require("crypto");
const path=require("path");
const {Pool}=require("pg");
const {watchPage}=require("./views/watch");
const {programPage}=require("./views/program");
const {libraryPage}=require("./views/library");

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
const TV_PUBLIC_INGEST_HLS=(process.env.STREAM_HLS_PUBLIC_BASE||"https://fbi-tv-live-ingest-production.up.railway.app").replace(/\/+$/,"");

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
function signLocalBridge(streamId,userId){return signPayload({sid:String(streamId),uid:String(userId),exp:Date.now()+12*60*60*1000},"local-studio")}
function readLocalBridge(value){return readSigned(value,"local-studio")}
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
    CREATE TABLE IF NOT EXISTS tv_mcr_config(
      id smallint PRIMARY KEY CHECK (id=1),
      program_stream_id uuid REFERENCES tv_streams(id) ON DELETE SET NULL,
      preview_stream_id uuid REFERENCES tv_streams(id) ON DELETE SET NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO tv_mcr_config(id,program_stream_id,preview_stream_id) VALUES(1,NULL,NULL) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS tv_viewer_saved(
      viewer_id text NOT NULL,
      stream_id uuid NOT NULL REFERENCES tv_streams(id) ON DELETE CASCADE,
      saved_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(viewer_id,stream_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tv_viewer_saved_viewer ON tv_viewer_saved(viewer_id,saved_at DESC);
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

const LOCAL_STUDIO_NAME="FBI TV Studio Output";

app.post("/api/local-studio/start",admin,async(req,res)=>{
  try{
    let q=await pool.query("SELECT * FROM tv_streams WHERE name=$1 LIMIT 1",[LOCAL_STUDIO_NAME]);
    if(!q.rowCount){
      const row={
        id:uid(),
        name:LOCAL_STUDIO_NAME,
        title:"FBI TV Local Studio Program",
        description:"Browser-based local camera, capture-card, screen and window studio output.",
        stream_key:token(18),
        viewer_token:token(24)
      };
      q=await pool.query(
        "INSERT INTO tv_streams(id,name,title,description,stream_key,viewer_token,enabled,shared,record_enabled,status) VALUES($1,$2,$3,$4,$5,$6,true,true,false,'offline') RETURNING *",
        [row.id,row.name,row.title,row.description,row.stream_key,row.viewer_token]
      );
    }else{
      await pool.query("UPDATE tv_streams SET enabled=true,shared=true,status='offline',updated_at=now() WHERE id=$1",[q.rows[0].id]);
      q=await pool.query("SELECT * FROM tv_streams WHERE id=$1",[q.rows[0].id]);
    }
    const row=q.rows[0];
    const cfg=await mcrConfig();
    const bridgeToken=signLocalBridge(row.id,req.adminUser.id);
    const wsProtocol=req.secure||req.headers["x-forwarded-proto"]==="https"?"wss":"ws";
    const host=req.get("host");
    res.json({
      ok:true,
      stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id),
      output_stream_id:row.id,
      ws_url:wsProtocol+"://"+host+"/ws/local-studio?token="+encodeURIComponent(bridgeToken),
      instructions:{
        cameras:"Camera and USB capture cards appear as browser video devices after permission.",
        screens:"Screen or Window opens the browser's native screen-share picker."
      }
    });
  }catch(e){
    console.error("Local studio start failed:",e);
    res.status(500).json({error:"Could not start local studio output"});
  }
});

app.post("/api/local-studio/stop",admin,async(req,res)=>{
  try{
    if(browserIngest)browserIngest.stopForUser(req.adminUser.id);
    const q=await pool.query("SELECT id FROM tv_streams WHERE name=$1 LIMIT 1",[LOCAL_STUDIO_NAME]);
    if(q.rowCount)await pool.query("UPDATE tv_streams SET status='offline',updated_at=now() WHERE id=$1",[q.rows[0].id]);
    res.json({ok:true});
  }catch(e){
    console.error("Local studio stop failed:",e);
    res.status(500).json({error:"Could not stop local studio output"});
  }
});


function hlsBackends(){
  const raw=[
    "http://fbi-tv-live-ingest:8888",
    process.env.STREAM_HLS_INTERNAL||"",
    MEDIA_BASE
  ];
  const out=[];
  for(const v of raw){
    const x=String(v||"").replace(/\/+$/,"");
    if(x&&!out.includes(x))out.push(x);
  }
  return out;
}
async function kickBridge(key){
  const base="http://fbi-tv-live-ingest:8888";
  const bridgePath="pull/live/"+encodeURIComponent(String(key||""))+"/index.m3u8";
  try{
    const r=await fetch(base+"/"+bridgePath,{cache:"no-store",redirect:"follow",signal:AbortSignal.timeout(2500)});
    try{await r.body?.cancel()}catch{}
    return r.ok;
  }catch{return false}
}
async function fetchPlayback(base,key,sub){
  const clean=String(sub||"index.m3u8").replace(/^\/+?/,"");
  const sourcePath="encoded/"+String(key||"");
  const url=new URL(base+"/"+sourcePath+(clean?"/"+clean:""));
  try{
    let r=await fetch(url,{cache:"no-store",redirect:"follow"});
    if((r.status===404||r.status===403)&&base==="http://fbi-tv-live-ingest:8888"){
      await kickBridge(key);
      r=await fetch(url,{cache:"no-store",redirect:"follow"});
    }
    return {response:r,sourcePath,backend:base};
  }catch(e){
    return null;
  }
}
async function checkRawInputLive(key){
  try{
    const base=MEDIA_BASE||"http://fbi-tv-media:8888";
    const r=await fetch(base+"/live/"+String(key||"")+"/index.m3u8",{cache:"no-store"});
    if(!r.ok)return false;
    return /#EXTM3U/.test(await r.text());
  }catch{return false}
}
async function checkBackendLive(base,key){
  try{
    const r=await fetch(base+"/encoded/"+String(key||"")+"/index.m3u8",{cache:"no-store"});
    if(r.ok)return /#EXTM3U/.test(await r.text());
  }catch{}
  return false;
}
async function refreshStreamStatusRow(row){
  const ingest="http://fbi-tv-live-ingest:8888";
  let live=await checkBackendLive(ingest,row.stream_key);
  if(!live && await checkRawInputLive(row.stream_key)){
    await kickBridge(row.stream_key);
    await new Promise(r=>setTimeout(r,650));
    live=await checkBackendLive(ingest,row.stream_key);
  }
  if(live!==String(row.status||"offline")==="live"){
    await pool.query("UPDATE tv_streams SET status=$1,updated_at=now() WHERE id=$2",[live?"live":"offline",row.id]);
  }
  return {...row,status:live?"live":"offline"};
}
function streamView(row, req, programId, previewId){
  const base=process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host");
  const publicHls="/api/public/watch/"+encodeURIComponent(row.viewer_token)+"/hls/index.m3u8";
  // MCR playback must stay on the same-origin, session-aware HLS proxy used by
  // the proven Client File Studio playback engine.
  const adminHls="/api/streams/"+encodeURIComponent(row.id)+"/hls/index.m3u8";
  return {
    id:row.id,name:row.name,title:row.title,description:row.description,stream_key:row.stream_key,
    enabled:row.enabled,shared:row.shared,record_enabled:row.record_enabled,status:row.status,
    current_viewers:Number(row.current_viewers||0),total_viewers:Number(row.total_viewers||0),
    rtmp_server:rtmpServer(),
    rtmp_url:rtmpServer()?rtmpServer()+"/"+row.stream_key:"",
    hls_url:adminHls,
    preview_url:adminHls,
    public_hls_url:publicHls,
    viewer_url:base+"/watch/"+row.viewer_token,
    live_url:base+"/live/"+row.id,
    is_program:String(programId||"")===String(row.id),
    is_preview:String(previewId||"")===String(row.id)
  };
}
async function mcrConfig(){
  const q=await pool.query("SELECT * FROM tv_mcr_config WHERE id=1");
  return q.rows[0]||{id:1,program_stream_id:null,preview_stream_id:null};
}

app.get("/api/streams",admin,async(req,res)=>{
  try{
    const cfg=await mcrConfig();
    const q=await pool.query("SELECT * FROM tv_streams ORDER BY updated_at DESC");
    const rows=[];
    for(const row of q.rows)rows.push(await refreshStreamStatusRow(row));
    res.json({streams:rows.map(row=>streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id))});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load live streams"});}
});

app.post("/api/streams",admin,async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name)return res.status(400).json({error:"Stream name is required"});
    const s={id:uid(),name,title:String(req.body.title||name).trim(),description:String(req.body.description||"").trim(),stream_key:token(18),viewer_token:token(24)};
    const q=await pool.query("INSERT INTO tv_streams(id,name,title,description,stream_key,viewer_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[s.id,s.name,s.title,s.description,s.stream_key,s.viewer_token]);
    const cfg=await mcrConfig();
    const row=await refreshStreamStatusRow(q.rows[0]);
    res.status(201).json({stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){console.error("Stream create failed:",e);res.status(500).json({error:"Could not create stream"});}
});

app.get("/api/streams/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    const cfg=await mcrConfig();
    const row=await refreshStreamStatusRow(q.rows[0]);
    res.json({stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){res.status(500).json({error:"Could not load stream"});}
});

app.patch("/api/streams/:id",admin,async(req,res)=>{
  try{
    const fields=[],vals=[];
    for(const k of ["name","title","description","shared","record_enabled","enabled"]){
      if(req.body[k]!==undefined){
        vals.push(k==="shared"||k==="record_enabled"||k==="enabled"?Boolean(req.body[k]):String(req.body[k]??"").trim().slice(0,2000));
        fields.push(k+"=$"+vals.length);
      }
    }
    if(!fields.length)return res.status(400).json({error:"Nothing to update"});
    vals.push(req.params.id);
    const q=await pool.query("UPDATE tv_streams SET "+fields.join(",")+",updated_at=now() WHERE id=$"+vals.length+" RETURNING *",vals);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    const cfg=await mcrConfig();
    const row=await refreshStreamStatusRow(q.rows[0]);
    res.json({stream:streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){console.error("Stream update failed:",e);res.status(500).json({error:"Could not update stream"});}
});

app.post("/api/streams/:id/regenerate-key",admin,async(req,res)=>{
  try{
    const key=token(18);
    const q=await pool.query("UPDATE tv_streams SET stream_key=$1,status='offline',updated_at=now() WHERE id=$2 RETURNING *",[key,req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    const cfg=await mcrConfig();
    res.json({stream:streamView(q.rows[0],req,cfg.program_stream_id,cfg.preview_stream_id)});
  }catch(e){res.status(500).json({error:"Could not regenerate stream key"});}
});

app.delete("/api/streams/:id",admin,async(req,res)=>{
  try{
    const q=await pool.query("DELETE FROM tv_streams WHERE id=$1 RETURNING id",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Stream not found"});
    await pool.query("UPDATE tv_mcr_config SET program_stream_id=NULL,preview_stream_id=NULL,updated_at=now() WHERE id=1 AND (program_stream_id=$1 OR preview_stream_id=$1)",[req.params.id]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Could not delete stream"});}
});

app.get("/api/mcr/overview",admin,async(req,res)=>{
  try{
    const cfg=await mcrConfig();
    const q=await pool.query("SELECT * FROM tv_streams WHERE enabled=true ORDER BY created_at ASC");
    const sources=[];
    for(const row of q.rows){
      const fresh=await refreshStreamStatusRow(row);
      sources.push(streamView(fresh,req,cfg.program_stream_id,cfg.preview_stream_id));
    }
    const program=sources.find(x=>String(x.id)===String(cfg.program_stream_id))||null;
    const preview=sources.find(x=>String(x.id)===String(cfg.preview_stream_id))||null;
    res.json({sources,program,preview,program_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/program"});
  }catch(e){console.error("MCR overview failed:",e);res.status(500).json({error:"Could not load MCR"});}
});

app.post("/api/mcr/preview",admin,async(req,res)=>{
  try{
    const id=String(req.body.streamId||"");
    if(id){
      const q=await pool.query("SELECT id FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
      if(!q.rowCount)return res.status(404).json({error:"Input source not found"});
    }
    const q=await pool.query("UPDATE tv_mcr_config SET preview_stream_id=$1,updated_at=now() WHERE id=1 RETURNING *",[id||null]);
    res.json({ok:true,preview_stream_id:q.rows[0].preview_stream_id||null});
  }catch(e){res.status(500).json({error:"Could not set preview source"});}
});

app.get("/api/mcr/program",admin,async(req,res)=>{
  try{
    const cfg=await mcrConfig();
    const q=cfg.program_stream_id?await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[cfg.program_stream_id]):{rowCount:0,rows:[]};
    const row=q.rowCount?await refreshStreamStatusRow(q.rows[0]):null;
    res.json({program:row?streamView(row,req,cfg.program_stream_id,cfg.preview_stream_id):null,program_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/program"});
  }catch(e){res.status(500).json({error:"Could not load program output"});}
});

app.post("/api/mcr/program",admin,async(req,res)=>{
  try{
    const id=String(req.body.streamId||"");
    if(id){
      const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
      if(!q.rowCount)return res.status(404).json({error:"Program source not found"});
    }
    const q=await pool.query("UPDATE tv_mcr_config SET program_stream_id=$1,updated_at=now() WHERE id=1 RETURNING *",[id||null]);
    const row=id?(await pool.query("SELECT * FROM tv_streams WHERE id=$1",[id])).rows[0]:null;
    const fresh=row?await refreshStreamStatusRow(row):null;
    res.json({ok:true,program:fresh?streamView(fresh,req,q.rows[0].program_stream_id,q.rows[0].preview_stream_id):null,program_url:(process.env.PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/program"});
  }catch(e){console.error("Program switch failed:",e);res.status(500).json({error:"Could not change program source"});}
});

app.post("/api/mediamtx/auth",async(req,res)=>{
  try{
    const action=String(req.body.action||"");
    const pathValue=String(req.body.path||"").replace(/^\/+|\/+$/g,"");
    const presentedToken=String(req.body.token||"");
    const presentedPassword=String(req.body.password||"");
    if(!pathValue)return res.status(401).end();

    // Match the proven Client File Studio authentication behavior:
    // resolve the parent stream path and allow the exact publish path
    // without requiring OBS/vMix to send a separate password.
    const q=await pool.query(
      "SELECT * FROM tv_streams WHERE stream_key=$1 LIMIT 1",
      [pathValue.replace(/^live\//,"").split("/")[0]]
    );
    if(!q.rowCount)return res.status(403).end();
    const stream=q.rows[0];
    const parentPath="live/"+stream.stream_key;
    const isExactPublishPath=pathValue===parentPath;
    const isStreamDescendant=pathValue.startsWith(parentPath+"/");

    if(action==="publish"){
      if(!stream.enabled)return res.status(403).end();
      if(!isExactPublishPath && !(isStreamDescendant && (presentedPassword===stream.stream_key || presentedToken===stream.stream_key))) {
        return res.status(403).end();
      }
      await pool.query("UPDATE tv_streams SET status='live',updated_at=now() WHERE id=$1",[stream.id]);
      return res.status(200).end();
    }

    if(action==="read"||action==="playback"){
      if(!stream.enabled||!stream.shared)return res.status(403).end();
      return res.status(200).end();
    }

    if(action==="api"||action==="metrics"||action==="pprof")return res.status(200).end();
    return res.status(403).end();
  }catch(e){
    console.error("MediaMTX auth failed:",e);
    res.status(500).end();
  }
});

app.get("/api/public/watch/:token/status",async(req,res)=>{
  const s=await publicStream(req.params.token);
  if(!s)return res.status(404).json({error:"Watch link is invalid or disabled."});
  let live=false;
  for(const base of hlsBackends()){
    if(await checkBackendLive(base,s.stream_key)){live=true;break;}
  }
  if(live!==("".concat(s.status)==="live")){
    await pool.query("UPDATE tv_streams SET status=$1,updated_at=now() WHERE id=$2",[live?"live":"offline",s.id]).catch(()=>{});
  }
  res.json({live,title:s.title,name:s.name,current_viewers:Number(s.current_viewers||0),hls_url:hlsProxyBase(req.params.token)});
});

async function proxyHlsStream(req,res){
  try{
    const id=String(req.params.id||"");
    const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true",[id]);
    if(!q.rowCount)return res.status(404).end();
    const row=q.rows[0];

    const internalBase=(process.env.STREAM_HLS_INTERNAL||"http://fbi-tv-live-ingest:8888").replace(/\/+$/,"");
    let sub=String(req.path||"/").replace(/^\/+/, "");
    // Accept URLs emitted by older cached players.
    if(/^index\.m3u8\/index\.m3u8$/i.test(sub))sub="index.m3u8";
    else if(/^index\.m3u8\//i.test(sub))sub=sub.slice("index.m3u8/".length);

    const upstreamPath="encoded/"+String(row.stream_key||"");
    const upstream=new URL(internalBase+"/"+upstreamPath+(sub?"/"+sub:""));

    for(const [k,v] of Object.entries(req.query||{}))upstream.searchParams.append(k,String(v));

    const incomingCookies=String(req.headers.cookie||"");
    const proxySession=(incomingCookies.match(/(?:^|;\s*)fbi_hls_session=([^;]+)/)||[])[1]||"";
    if(proxySession&&!upstream.searchParams.has("session"))upstream.searchParams.set("session",proxySession);

    // The first HLS request is intentionally made without MediaMTX's cookie.
    // cookieCheck=1 forces MediaMTX to emit a query-based HLS session.
    if(sub==="index.m3u8"&&!upstream.searchParams.has("session"))upstream.searchParams.set("cookieCheck","1");

    const response=await fetch(upstream,{redirect:"follow",cache:"no-store"});
    const type=response.headers.get("content-type")||"application/octet-stream";
    let body=Buffer.from(await response.arrayBuffer());
    if(!response.ok)return res.status(response.status).type(type).send(body);

    if(type.toLowerCase().includes("mpegurl")){
      let textBody=body.toString("utf8");
      let session="";
      const setCookies=typeof response.headers.getSetCookie==="function"
        ? response.headers.getSetCookie()
        : String(response.headers.get("set-cookie")||"").split(/,(?=\s*\w+=)/);
      for(const sc of setCookies){
        const m=String(sc).match(/(?:^|;\s*)hlsSession=([^;]+)/i);
        if(m){session=m[1];break;}
      }
      session=session||upstream.searchParams.get("session")||"";

      function proxyUri(raw){
        const value=String(raw||"").trim();
        if(!value)return value;
        try{
          const absolute=/^https?:\/\//i.test(value)?new URL(value):null;
          let pathname=absolute?absolute.pathname:value.split("?")[0];
          let query=absolute?absolute.search:value.includes("?")?"?"+value.split("?").slice(1).join("?"):"";
          const marker="/"+upstreamPath+"/";
          const markerIndex=pathname.indexOf(marker);
          if(markerIndex>=0)pathname=pathname.slice(markerIndex+marker.length);
          pathname=pathname.replace(/^\/+/,"");
          const proxyBase="/api/streams/"+encodeURIComponent(id)+"/hls/";
          const url=proxyBase+pathname;
          const sp=new URLSearchParams(query.replace(/^\?/,""));
          if(session&&!sp.has("session"))sp.set("session",session);
          const suffix=sp.toString();
          return url+(suffix?"?"+suffix:"");
        }catch{
          return value;
        }
      }

      textBody=textBody.split(/\r?\n/).map(function(line){
        const trimmed=line.trim();
        if(!trimmed)return line;
        if(/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|MAP):/i.test(trimmed)){
          return line.replace(/URI="([^"]+)"/gi,function(_,uri){return 'URI="'+proxyUri(uri)+'"';});
        }
        if(trimmed[0]==="#")return line;
        return proxyUri(trimmed);
      }).join("\n");
      body=Buffer.from(textBody,"utf8");

      if(session){
        res.setHeader("Set-Cookie","fbi_hls_session="+encodeURIComponent(session)+"; Path=/api/streams/"+encodeURIComponent(id)+"/hls; HttpOnly; Secure; SameSite=Lax; Max-Age=1800");
      }
    }

    res.status(200)
      .set("Cache-Control",type.toLowerCase().includes("mpegurl")?"no-store, no-cache, must-revalidate":"no-cache")
      .type(type)
      .send(body);
  }catch(e){
    console.error("HLS proxy error:",e?.stack||e);
    res.status(502).json({error:"Live stream playback proxy unavailable."});
  }
}

app.use("/api/streams/:id/hls",admin,async(req,res)=>{
  await proxyHlsStream(req,res);
});


app.post("/api/public/watch/:token/heartbeat",async(req,res)=>{
  const s=await publicStream(req.params.token);if(!s)return res.status(404).end();
  await pool.query("UPDATE tv_streams SET current_viewers=GREATEST(0,current_viewers+0),total_viewers=GREATEST(total_viewers,0),updated_at=now() WHERE id=$1",[s.id]);
  res.json({ok:true});
});


async function selectedProgram(){
  const cfg=await mcrConfig();
  if(!cfg.program_stream_id)return null;
  const q=await pool.query("SELECT * FROM tv_streams WHERE id=$1 AND enabled=true AND shared=true",[cfg.program_stream_id]);
  return q.rowCount?q.rows[0]:null;
}
app.get("/api/public/program/status",async(req,res)=>{
  try{
    const row=await selectedProgram();
    if(!row)return res.json({live:false,program:null,hls_url:"/api/public/program/hls/index.m3u8"});
    const fresh=await refreshStreamStatusRow(row);
    res.json({live:fresh.status==="live",program:{id:fresh.id,name:fresh.name,title:fresh.title,current_viewers:Number(fresh.current_viewers||0)},hls_url:"/api/public/program/hls/index.m3u8"});
  }catch(e){res.status(500).json({error:"Program status unavailable"});}
});


async function proxyProgramHlsStream(req,res){
  try{
    const row=await selectedProgram();
    if(!row)return res.status(404).end();

    const internalBase=(process.env.STREAM_HLS_INTERNAL||"http://fbi-tv-live-ingest:8888").replace(/\/+$/,"");
    let sub=String(req.path||"/").replace(/^\/+/,"");
    if(/^index\.m3u8\/index\.m3u8$/i.test(sub))sub="index.m3u8";
    else if(/^index\.m3u8\//i.test(sub))sub=sub.slice("index.m3u8/".length);

    const upstreamPath="encoded/"+String(row.stream_key||"");
    const upstream=new URL(internalBase+"/"+upstreamPath+(sub?"/"+sub:""));
    for(const [k,v] of Object.entries(req.query||{}))upstream.searchParams.append(k,String(v));

    const incomingCookies=String(req.headers.cookie||"");
    const proxySession=(incomingCookies.match(/(?:^|;\s*)fbi_program_hls_session=([^;]+)/)||[])[1]||"";
    if(proxySession&&!upstream.searchParams.has("session"))upstream.searchParams.set("session",decodeURIComponent(proxySession));
    if(sub==="index.m3u8"&&!upstream.searchParams.has("session"))upstream.searchParams.set("cookieCheck","1");

    const response=await fetch(upstream,{redirect:"follow",cache:"no-store"});
    const type=response.headers.get("content-type")||"application/octet-stream";
    let body=Buffer.from(await response.arrayBuffer());
    if(!response.ok)return res.status(response.status).type(type).send(body);

    if(type.toLowerCase().includes("mpegurl")){
      let textBody=body.toString("utf8");
      let session="";
      const setCookies=typeof response.headers.getSetCookie==="function"
        ? response.headers.getSetCookie()
        : String(response.headers.get("set-cookie")||"").split(/,(?=\s*\w+=)/);
      for(const sc of setCookies){
        const m=String(sc).match(/(?:^|;\s*)hlsSession=([^;]+)/i);
        if(m){session=m[1];break;}
      }
      session=session||upstream.searchParams.get("session")||"";

      function programUri(raw){
        const value=String(raw||"").trim();
        if(!value)return value;
        try{
          const absolute=/^https?:\/\//i.test(value)?new URL(value):null;
          let pathname=absolute?absolute.pathname:value.split("?")[0];
          let query=absolute?absolute.search:value.includes("?")?"?"+value.split("?").slice(1).join("?"):"";
          const marker="/"+upstreamPath+"/";
          const markerIndex=pathname.indexOf(marker);
          if(markerIndex>=0)pathname=pathname.slice(markerIndex+marker.length);
          pathname=pathname.replace(/^\/+/,"");
          const base="/api/public/program/hls/";
          const url=base+pathname;
          const sp=new URLSearchParams(query.replace(/^\?/,""));
          if(session&&!sp.has("session"))sp.set("session",session);
          const suffix=sp.toString();
          return url+(suffix?"?"+suffix:"");
        }catch{return value}
      }

      textBody=textBody.split(/\r?\n/).map(line=>{
        const trimmed=line.trim();
        if(!trimmed)return line;
        if(/^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|MAP):/i.test(trimmed)){
          return line.replace(/URI="([^"]+)"/gi,(_,uri)=>'URI="'+programUri(uri)+'"');
        }
        if(trimmed[0]==="#")return line;
        return programUri(trimmed);
      }).join("\n");
      body=Buffer.from(textBody,"utf8");
      if(session){
        res.setHeader("Set-Cookie","fbi_program_hls_session="+encodeURIComponent(session)+"; Path=/api/public/program/hls; HttpOnly; Secure; SameSite=Lax; Max-Age=1800");
      }
    }

    res.status(200)
      .set("Cache-Control",type.toLowerCase().includes("mpegurl")?"no-store, no-cache, must-revalidate":"no-cache")
      .type(type)
      .send(body);
  }catch(e){
    console.error("Program HLS proxy error:",e?.stack||e);
    res.status(502).json({error:"Program live playback unavailable."});
  }
}

app.use("/api/public/program/hls",async(req,res)=>{
  await proxyProgramHlsStream(req,res);
});

app.get("/watch/program",(req,res)=>{
  res.type("html").send(programPage());
});

// ---- Viewer "Save for later" (additive; does not touch playback) ----
const VIEWER_COOKIE="fbi_tv_viewer";
function viewerId(req,res){
  let id=cookies(req)[VIEWER_COOKIE];
  if(!/^[A-Za-z0-9_-]{20,64}$/.test(String(id||""))){
    id=token(24);
    res.append("Set-Cookie",VIEWER_COOKIE+"="+id+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000");
  }
  return id;
}
app.get("/api/public/watch/:token/saved",async(req,res)=>{
  try{
    const s=await publicStream(req.params.token);if(!s)return res.status(404).json({error:"Watch link is invalid or disabled."});
    const q=await pool.query("SELECT 1 FROM tv_viewer_saved WHERE viewer_id=$1 AND stream_id=$2",[viewerId(req,res),s.id]);
    res.set("Cache-Control","no-store").json({saved:q.rowCount>0});
  }catch(e){console.error("Saved check failed:",e?.message||e);res.status(500).json({error:"Could not check saved status."})}
});
app.post("/api/public/watch/:token/save",async(req,res)=>{
  try{
    const s=await publicStream(req.params.token);if(!s)return res.status(404).json({error:"Watch link is invalid or disabled."});
    const vid=viewerId(req,res);
    const count=await pool.query("SELECT count(*)::int AS c FROM tv_viewer_saved WHERE viewer_id=$1",[vid]);
    if(Number(count.rows[0]?.c||0)>=200)return res.status(400).json({error:"Your saved list is full."});
    await pool.query("INSERT INTO tv_viewer_saved(viewer_id,stream_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[vid,s.id]);
    res.json({ok:true,saved:true});
  }catch(e){console.error("Save failed:",e?.message||e);res.status(500).json({error:"Could not save."})}
});
app.delete("/api/public/watch/:token/save",async(req,res)=>{
  try{
    const s=await publicStream(req.params.token);if(!s)return res.status(404).json({error:"Watch link is invalid or disabled."});
    await pool.query("DELETE FROM tv_viewer_saved WHERE viewer_id=$1 AND stream_id=$2",[viewerId(req,res),s.id]);
    res.json({ok:true,saved:false});
  }catch(e){console.error("Unsave failed:",e?.message||e);res.status(500).json({error:"Could not remove."})}
});
app.get("/api/public/saved",async(req,res)=>{
  try{
    const q=await pool.query(
      "SELECT s.name,s.title,s.viewer_token AS token,s.status,v.saved_at FROM tv_viewer_saved v JOIN tv_streams s ON s.id=v.stream_id WHERE v.viewer_id=$1 AND s.enabled=true AND s.shared=true ORDER BY v.saved_at DESC LIMIT 200",
      [viewerId(req,res)]);
    res.set("Cache-Control","no-store").json({items:q.rows.map(r=>({name:r.name,title:r.title,token:r.token,live:r.status==="live",saved_at:r.saved_at}))});
  }catch(e){console.error("Saved list failed:",e?.message||e);res.status(500).json({error:"Could not load saved list."})}
});
app.get("/library",(req,res)=>{res.type("html").send(libraryPage())});

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
  res.type("html").send(watchPage({token:req.params.token,title:esc(s.title||s.name),description:esc(s.description||"")}));
});

const index=path.join(__dirname,"public/index.html");
app.use(express.static(path.join(__dirname,"public")));
app.get("/",(req,res)=>res.sendFile(index));
async function primeLiveBridges(){
  try{
    const q=await pool.query("SELECT s.* FROM tv_streams s WHERE s.enabled=true AND (s.status='live' OR s.id IN (SELECT program_stream_id FROM tv_mcr_config WHERE id=1 AND program_stream_id IS NOT NULL) OR s.id IN (SELECT preview_stream_id FROM tv_mcr_config WHERE id=1 AND preview_stream_id IS NOT NULL))");
    for(const row of q.rows)await kickBridge(row.stream_key);
  }catch(e){console.error("Bridge priming failed:",e?.message||e)}
}
const httpServer=http.createServer(app);
const browserIngest=attachBrowserIngest(httpServer,{
  pool,
  verifyToken:readLocalBridge,
  rtmpBase:"rtmp://fbi-tv-live-ingest:1935/live"
});

init().then(async()=>{
  await primeLiveBridges();
  httpServer.listen(PORT,()=>console.log("FBI TV Control listening on port "+PORT));
}).catch(e=>{console.error(e);process.exit(1)});
