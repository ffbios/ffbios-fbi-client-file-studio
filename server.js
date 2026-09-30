const express=require("express");
const Busboy=require("busboy");
const {Pool}=require("pg");
const crypto=require("crypto");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");
const {spawn}=require("child_process");
let ffmpegPath="";try{ffmpegPath=require("ffmpeg-static")||""}catch(e){console.warn("ffmpeg-static is unavailable; video thumbnails will use fallback cards.")}
const {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand,DeleteObjectsCommand,HeadObjectCommand,CreateMultipartUploadCommand,UploadPartCommand,CompleteMultipartUploadCommand,AbortMultipartUploadCommand,ListPartsCommand,PutBucketCorsCommand}=require("@aws-sdk/client-s3");
const {Upload}=require("@aws-sdk/lib-storage");
const {getSignedUrl}=require("@aws-sdk/s3-request-presigner");
const sharp=require("sharp");
const thumbnailCache=new Map();
const THUMB_CACHE_MAX=300;
const THUMB_CACHE_TTL=30*60*1000;
function getThumbCache(key){
  const v=thumbnailCache.get(key);
  if(!v)return null;
  if(v.expires<Date.now()){thumbnailCache.delete(key);return null;}
  thumbnailCache.delete(key);thumbnailCache.set(key,v);
  return v;
}
function setThumbCache(key,buffer){
  // cache helper remains unchanged; media-aware thumbnail helpers follow below.

  thumbnailCache.set(key,{buffer,expires:Date.now()+THUMB_CACHE_TTL});
  while(thumbnailCache.size>THUMB_CACHE_MAX)thumbnailCache.delete(thumbnailCache.keys().next().value);
  return buffer;
}


function thumbKind(file){
  const mime=String(file?.mime_type||"").toLowerCase();
  if(/^image\//.test(mime))return"image";
  if(/^video\//.test(mime))return"video";
  if(/^audio\//.test(mime))return"audio";
  return"document";
}
function thumbExt(name){
  return String(name||"").split(".").pop().toLowerCase().replace(/[^a-z0-9+#-]/g,"").slice(0,8).toUpperCase()||"FILE";
}
function thumbDocFamily(name,mime){
  const ext=thumbExt(name);
  const m=String(mime||"").toLowerCase();
  if(ext==="PDF"||m==="application/pdf")return"PDF";
  if(["DOC","DOCX","ODT","RTF","TXT"].includes(ext))return ext;
  if(["XLS","XLSX","ODS","CSV"].includes(ext))return ext;
  if(["PPT","PPTX","ODP"].includes(ext))return ext;
  if(["ZIP","RAR","7Z"].includes(ext)||/zip|rar|7z/.test(m))return ext;
  return ext||"FILE";
}
function thumbXml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function documentThumbSvg(file,width){
  const ext=thumbDocFamily(file?.original_name,file?.mime_type);
  const rawName=String(file?.original_name||"Document");
  const base=rawName.split("/").pop()||rawName;
  const label=base.length>26?base.slice(0,23)+"…":base;
  const family=ext==="PDF"?"PDF":(["DOC","DOCX","ODT","RTF","TXT"].includes(ext)?"DOCUMENT":(["XLS","XLSX","ODS","CSV"].includes(ext)?"SPREADSHEET":(["PPT","PPTX","ODP"].includes(ext)?"PRESENTATION":(["ZIP","RAR","7Z"].includes(ext)?"ARCHIVE":"FILE"))));
  const w=Math.max(240,Math.min(900,Number(width)||360)),h=Math.round(w*1.25);
  const line1=label.length>18?label.slice(0,18)+"…":label;
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'">'+
    '<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#171719"/><stop offset="1" stop-color="#0b0b0d"/></linearGradient></defs>'+
    '<rect width="100%" height="100%" rx="24" fill="url(#bg)"/>'+
    '<rect x="18" y="18" width="'+(w-36)+'" height="'+(h-36)+'" rx="18" fill="#f3f1eb"/>'+
    '<path d="M '+(w-112)+' 18 V 112 H '+(w-18)+'" fill="#e8e5de"/>'+
    '<path d="M '+(w-112)+' 18 L '+(w-18)+' 112 H '+(w-112)+' Z" fill="#d4d0c6"/>'+
    '<rect x="42" y="56" width="'+Math.min(72,w-84)+'" height="8" rx="4" fill="#c7a53d"/>'+
    '<rect x="42" y="78" width="'+Math.min(150,w-84)+'" height="6" rx="3" fill="#b3b0aa"/>'+
    '<rect x="42" y="108" width="'+Math.min(132,w-84)+'" height="6" rx="3" fill="#c6c3bd"/>'+
    '<rect x="42" y="150" width="'+Math.min(190,w-84)+'" height="10" rx="5" fill="#242428"/>'+
    '<rect x="42" y="172" width="'+Math.min(220,w-84)+'" height="7" rx="3.5" fill="#cac8c3"/>'+
    '<rect x="42" y="188" width="'+Math.min(198,w-84)+'" height="7" rx="3.5" fill="#d4d1cb"/>'+
    '<rect x="42" y="'+(h-132)+'" width="'+Math.min(138,w-84)+'" height="48" rx="12" fill="#171719"/>'+
    '<text x="62" y="'+(h-101)+'" font-family="Arial,Helvetica,sans-serif" font-size="18" font-weight="800" fill="#e7c75d">'+thumbXml(ext)+'</text>'+
    '<text x="42" y="'+(h-58)+'" font-family="Arial,Helvetica,sans-serif" font-size="14" font-weight="700" fill="#55545a">'+thumbXml(family)+'</text>'+
    '<text x="'+(w-42)+'" y="'+(h-58)+'" text-anchor="end" font-family="Arial,Helvetica,sans-serif" font-size="11" font-weight="700" fill="#8b8984">'+thumbXml(line1)+'</text>'+
  '</svg>');
}
function audioThumbSvg(file,width){
  const ext=thumbExt(file?.original_name);
  const w=Math.max(240,Math.min(900,Number(width)||360)),h=Math.round(w*0.56);
  return Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
    '<rect width="100%" height="100%" rx="24" fill="#101012"/><circle cx="'+(w/2)+'" cy="'+(h/2-6)+'" r="'+Math.min(58,h*.25)+'" fill="#c7a53d"/>'+
    '<path d="M '+(w/2-16)+' '+(h/2-28)+' L '+(w/2+18)+' '+(h/2-8)+' L '+(w/2-16)+' '+(h/2+12)+' Z" fill="#101012"/>'+
    '<text x="'+(w/2)+'" y="'+(h-20)+'" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="800" fill="#efefef">'+thumbXml(ext)+'</text></svg>');
}
function runFfmpegPoster(url,seekSeconds){
  return new Promise((resolve,reject)=>{
    if(!ffmpegPath)return reject(new Error("FFmpeg is not available"));
    const args=["-hide_banner","-loglevel","error","-ss",String(seekSeconds),"-i",url,"-frames:v","1","-vf","scale=1280:-2:flags=lanczos","-q:v","5","-f","image2pipe","-vcodec","mjpeg","pipe:1"];
    const child=spawn(ffmpegPath,args,{stdio:["ignore","pipe","pipe"]});
    const chunks=[];let errText="";let settled=false;
    const finish=(err,val)=>{if(settled)return;settled=true;clearTimeout(timer);err?reject(err):resolve(val)};
    const timer=setTimeout(()=>{try{child.kill("SIGKILL")}catch{}finish(new Error("Video thumbnail generation timed out"))},45000);
    child.stdout.on("data",c=>chunks.push(c));
    child.stderr.on("data",c=>{errText+=String(c||"")});
    child.on("error",e=>finish(e));
    child.on("close",(code,signal)=>{
      if(code===0&&chunks.length)return finish(null,Buffer.concat(chunks));
      finish(new Error(errText.trim()||("FFmpeg exited with code "+String(code||signal||"unknown"))));
    });
  });
}
async function generateThumbnail(file,width,height){
  const kind=thumbKind(file);
  if(kind==="document")return sharp(documentThumbSvg(file,width)).webp({quality:86,method:4}).toBuffer();
  if(kind==="audio")return sharp(audioThumbSvg(file,width)).webp({quality:84,method:4}).toBuffer();
  if(kind==="video"){
    try{
      const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}),{expiresIn:300});
      let frame;
      try{frame=await runFfmpegPoster(url,1)}catch(_e){frame=await runFfmpegPoster(url,0)}
      return sharp(frame).rotate().resize({width:width,height:height,fit:"inside",withoutEnlargement:true}).webp({quality:76,method:4}).toBuffer();
    }catch(e){
      console.warn("Video thumbnail fallback:",file?.original_name,e?.message||e);
      return sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+Math.round(width*9/16)+'"><rect width="100%" height="100%" fill="#101012"/><circle cx="'+(width/2)+'" cy="'+(Math.round(width*9/16)/2)+'" r="'+Math.min(60,width*.15)+'" fill="#c7a53d"/><path d="M '+(width/2-16)+' '+(Math.round(width*9/16)/2-24)+' L '+(width/2+22)+' '+(Math.round(width*9/16)/2)+' L '+(width/2-16)+' '+(Math.round(width*9/16)/2+24)+' Z" fill="#101012"/></svg>')).webp({quality:84,method:4}).toBuffer();
    }
  }
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:file.storage_path}));
  const input=obj.Body?.transformToByteArray?Buffer.from(await obj.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];obj.Body.on("data",c=>chunks.push(c));obj.Body.on("end",()=>resolve(Buffer.concat(chunks)));obj.Body.on("error",reject)}));
  return sharp(input).rotate().resize({width:width,height:height,fit:"inside",withoutEnlargement:true}).webp({quality:68,method:4}).toBuffer();
}

const app=express();
const PORT=Number(process.env.PORT||3000);
const ROOT=path.join(__dirname,"site");
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").replace(/\/+$/,"");
const MAX_FILE_SIZE=5*1000*1000*1000*1000;
const STORAGE_QUOTA_BYTES=Number(process.env.STORAGE_QUOTA_BYTES||100000000000000);
const MIN_PART_SIZE=64*1024*1024;
const MAX_PARTS=10000;
const PRESIGN_SECONDS=1200;

const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.DATABASE_URL?{rejectUnauthorized:false}:false});

function uid(){return crypto.randomUUID()}
function token(){return crypto.randomBytes(24).toString("base64url")}
function safeName(name){
  const ext=path.extname(name);
  const base=path.basename(name,ext).replace(/[^a-zA-Z0-9._-]+/g,"_").replace(/^\.+/,"").slice(0,140)||"file";
  return base+ext;
}
function cookies(req){const out={};for(const p of String(req.headers.cookie||"").split(";")){const i=p.indexOf("=");if(i>0)out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim())}return out}
function session(email){
  const exp=Date.now()+604800000;
  const payload=Buffer.from(JSON.stringify({email,exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validSession(req){
  const s=cookies(req).fbi_session;if(!s)return false;
  const [payload,sig]=s.split(".");if(!payload||!sig)return false;
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  try{
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return false;
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return data.email===ADMIN_EMAIL&&Number(data.exp)>Date.now();
  }catch{return false}
}
function admin(req,res,next){if(!validSession(req))return res.status(401).json({error:"Unauthorised"});next()}
function userSession(user){
  const exp=Date.now()+30*86400000;
  const payload=Buffer.from(JSON.stringify({uid:user.id,email:user.email,exp:exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validUserSession(req){
  const s=cookies(req).fbi_user_session;if(!s)return null;
  const parts=s.split("."),payload=parts[0],sig=parts[1];if(!payload||!sig)return null;
  try{
    const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
    if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))return null;
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    if(!data.uid||!data.email||Number(data.exp)<=Date.now())return null;
    return {id:String(data.uid),email:String(data.email).toLowerCase()};
  }catch{return null}
}
function portalUser(req,res,next){
  const u=validUserSession(req);
  if(!u)return res.status(401).json({error:"Please log in to your account."});
  req.portalUser=u;next();
}
async function hashUserPassword(password){
  const N=32768,r=8,p=1,salt=crypto.randomBytes(16);
  const derived=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N:N,r:r,p:p,maxmem:256*1024*1024},(e,d)=>e?reject(e):resolve(d)));
  return "scrypt$"+N+"$"+r+"$"+p+"$"+salt.toString("base64")+"$"+Buffer.from(derived).toString("base64");
}
async function userPasswordMatches(password,stored){
  try{
    const parts=String(stored||"").split("$"),prefix=parts[0],N=parts[1],r=parts[2],p=parts[3],salt=parts[4],hash=parts[5];
    if(prefix!=="scrypt"||!N||!r||!p||!salt||!hash)return false;
    const derived=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(salt,"base64"),64,{N:Number(N),r:Number(r),p:Number(p),maxmem:256*1024*1024},(e,d)=>e?reject(e):resolve(d)));
    const actual=Buffer.from(hash,"base64");
    return actual.length===derived.length&&crypto.timingSafeEqual(actual,derived);
  }catch{return false}
}
async function portalProjectOwned(userId,projectId){
  const r=await pool.query("SELECT * FROM projects WHERE id=$1 AND owner_id=$2",[projectId,userId]);
  return r.rows[0]||null;
}
function clientIp(req){return String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim().slice(0,120)}
function s3Ready(){return Boolean(process.env.S3_BUCKET&&process.env.S3_ENDPOINT&&process.env.S3_ACCESS_KEY_ID&&process.env.S3_SECRET_ACCESS_KEY&&process.env.S3_REGION)}
const s3=s3Ready()?new S3Client({
  region:process.env.S3_REGION,
  endpoint:process.env.S3_ENDPOINT,
  forcePathStyle:false,
  credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}
}):null;
const bucket=()=>process.env.S3_BUCKET;

function choosePartSize(size){
  var part=MIN_PART_SIZE;
  while(Math.ceil(size/part)>MAX_PARTS) part*=2;
  return part;
}
function safeRelativePath(rel,name){
  var raw=String(rel||name||"").replace(/\\/g,"/");
  var parts=raw.split("/").filter(Boolean).filter(function(x){return x!=="."&&x!=="..";}).map(function(x){
    return x.replace(/[<>:"|?*\\\u0000-\u001F]/g,"_").slice(0,180);
  }).filter(Boolean);
  return parts.length?parts.join("/"):safeName(name);
}
async function ensureBucketCors(){
  if(!s3Ready())return;
  try{
    await s3.send(new PutBucketCorsCommand({
      Bucket:bucket(),
      CORSConfiguration:{CORSRules:[{
        AllowedOrigins:["*"],
        AllowedMethods:["GET","HEAD","PUT","POST","DELETE"],
        AllowedHeaders:["*"],
        ExposeHeaders:["ETag"],
        MaxAgeSeconds:3600
      }]}
    }));
    console.log("Railway bucket CORS is configured.");
  }catch(e){
    console.warn("Automatic bucket CORS setup failed:",e.message);
  }
}


async function initDb(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing");
  if(!s3Ready())console.warn("Railway bucket variables are not ready yet.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(
      id uuid PRIMARY KEY,
      email text UNIQUE NOT NULL,
      full_name text NOT NULL DEFAULT '',
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS projects(
      id uuid PRIMARY KEY,
      owner_id uuid REFERENCES users(id) ON DELETE SET NULL,
      name text NOT NULL,
      client_name text DEFAULT '',
      client_email text DEFAULT '',
      note text DEFAULT '',
      share_token text UNIQUE,
      shared boolean NOT NULL DEFAULT false,
      expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS files(
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      original_name text NOT NULL,
      storage_name text NOT NULL,
      storage_path text NOT NULL,
      mime_type text NOT NULL DEFAULT 'application/octet-stream',
      size_bytes bigint NOT NULL DEFAULT 0,
      content_fingerprint text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS downloads(
      id bigserial PRIMARY KEY,
      project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
      file_id uuid REFERENCES files(id) ON DELETE SET NULL,
      downloaded_at timestamptz NOT NULL DEFAULT now(),
      user_agent text DEFAULT '',
      ip_address text DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
    CREATE INDEX IF NOT EXISTS idx_downloads_project ON downloads(project_id);

    CREATE TABLE IF NOT EXISTS upload_sessions(
      id uuid PRIMARY KEY,
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      original_name text NOT NULL,
      relative_path text NOT NULL DEFAULT '',
      storage_key text NOT NULL,
      mime_type text NOT NULL DEFAULT 'application/octet-stream',
      size_bytes bigint NOT NULL DEFAULT 0,
      part_size bigint NOT NULL DEFAULT 0,
      multipart_upload_id text,
      mode text NOT NULL,
      status text NOT NULL DEFAULT 'active',
      content_fingerprint text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_id);
    ALTER TABLE files ADD COLUMN IF NOT EXISTS relative_path text NOT NULL DEFAULT '';
    ALTER TABLE files ADD COLUMN IF NOT EXISTS content_fingerprint text;
    ALTER TABLE files ADD COLUMN IF NOT EXISTS sha256 text;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS idx_files_fingerprint ON files(project_id,content_fingerprint,size_bytes);
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_project ON upload_sessions(project_id);
    ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS content_fingerprint text;
    CREATE INDEX IF NOT EXISTS idx_upload_sessions_active ON upload_sessions(project_id,status);
    CREATE TABLE IF NOT EXISTS streams(
      id uuid PRIMARY KEY,
      name text NOT NULL,
      title text DEFAULT '',
      description text DEFAULT '',
      stream_key text UNIQUE NOT NULL,
      stream_path text UNIQUE NOT NULL,
      viewer_token text UNIQUE NOT NULL,
      shared boolean NOT NULL DEFAULT true,
      enabled boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'offline',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      ended_at timestamptz
    );
    CREATE TABLE IF NOT EXISTS stream_viewers(
      id uuid PRIMARY KEY,
      stream_id uuid NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
      session_key text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      last_seen timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      user_agent text DEFAULT '',
      ip_address text DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_streams_updated ON streams(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stream_viewers_stream ON stream_viewers(stream_id,last_seen);
    CREATE TABLE IF NOT EXISTS ndi_gateways(
      id uuid PRIMARY KEY,
      name text NOT NULL DEFAULT '',
      pair_token text UNIQUE NOT NULL,
      version text DEFAULT '',
      capabilities jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'offline',
      active_input text DEFAULT '',
      active_output text DEFAULT '',
      last_ip text DEFAULT '',
      last_seen timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_ndi_gateways_seen ON ndi_gateways(last_seen DESC);
    CREATE TABLE IF NOT EXISTS app_settings(
      key text PRIMARY KEY,
      value text NOT NULL DEFAULT ''
    );
    INSERT INTO app_settings(key,value) VALUES
      ('studio_name','FBI Client File Studio'),
      ('portal_title','FBI Client File Delivery'),
      ('default_client_note','Your files are ready for download.'),
      ('default_expiry_days','30'),
      ('log_downloads','true'),
      ('allow_client_preview','true'),
      ('show_file_size','true')
    ON CONFLICT (key) DO NOTHING;
  `);
}


const DEFAULT_SETTINGS={
  studio_name:"FBI Client File Studio",
  portal_title:"FBI Client File Delivery",
  default_client_note:"Your files are ready for download.",
  default_expiry_days:"30",
  log_downloads:"true",
  allow_client_preview:"true",
  show_file_size:"true"
};
async function loadSettings(){
  const r=await pool.query("SELECT key,value FROM app_settings");
  const out={...DEFAULT_SETTINGS};
  for(const row of r.rows)out[row.key]=row.value;
  return out;
}
function settingBool(v){return String(v)==="true";}
function settingInt(v,fallback){const n=Number(v);return Number.isFinite(n)?Math.max(0,Math.min(3650,Math.round(n))):fallback;}
function formatStorageBytes(v){
  var n=Math.max(0,Number(v||0));
  if(n===0)return"0 B";
  var units=["B","KB","MB","GB","TB","PB"],i=0;
  while(n>=1000&&i<units.length-1){n/=1000;i++;}
  return (i===0?n.toFixed(0):n<10?n.toFixed(2):n<100?n.toFixed(1):n.toFixed(0))+" "+units[i];
}
async function adminPasswordMatches(password){
  const r=await pool.query("SELECT value FROM app_settings WHERE key='admin_password_hash'");
  const stored=r.rows[0]?.value||"";
  if(!stored)return ADMIN_PASSWORD && password===ADMIN_PASSWORD;
  try{
    const [prefix,N,r,p,salt,hash]=stored.split("$");
    if(prefix!=="scrypt"||!N||!r||!p||!salt||!hash)return false;
    const derived=await new Promise((resolve,reject)=>crypto.scrypt(password,Buffer.from(salt,"base64"),64,{N:Number(N),r:Number(r),p:Number(p),maxmem:128*1024*1024},(e,d)=>e?reject(e):resolve(d)));
    return crypto.timingSafeEqual(Buffer.from(hash,"base64"),derived);
  }catch{return false;}
}
async function hashAdminPassword(password){
  const N=16384,r=8,p=1,salt=crypto.randomBytes(16),derived=await new Promise((resolve,reject)=>crypto.scrypt(password,salt,64,{N,r,p,maxmem:128*1024*1024},(e,d)=>e?reject(e):resolve(d)));
  return `scrypt${N}${r}${p}${salt.toString("base64")}${Buffer.from(derived).toString("base64")}`;
}


function escHtml(v){return String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function streamPathForKey(key){return "live/"+key;}
function streamHlsUrl(row){
  const base=String(process.env.STREAM_HLS_BASE||"").replace(/\/+$/,"");
  return base+"/"+row.stream_path;
}
function randomStreamKey(){return crypto.randomBytes(24).toString("base64url");}
function randomViewerToken(){return crypto.randomBytes(24).toString("base64url");}
function randomNdiPairToken(){return crypto.randomBytes(20).toString("base64url");}
function streamRtmpServer(){const h=String(process.env.STREAM_RTMP_HOST||"").trim(),p=String(process.env.STREAM_RTMP_PORT||"").trim();return h&&p?"rtmp://"+h+":"+p+"/live":"";}
function parseQueryString(q){
  const raw=String(q||"");
  const out={};
  try{const params=new URLSearchParams(raw);for(const [k,v] of params.entries())out[k]=v;}catch{}
  return out;
}
async function checkStreamLive(row){
  if(!row || !row.enabled)return false;
  const url=streamHlsUrl(row)+"/index.m3u8";
  if(!url.startsWith("http"))return false;
  try{
    const r=await fetch(url,{method:"GET",cache:"no-store"});
    if(!r.ok)return false;
    const text=await r.text();
    return /#EXTM3U/.test(text);
  }catch{return false;}
}
async function refreshStreamStatus(row){
  const live=await checkStreamLive(row);
  const status=live?"live":"offline";
  if(status!==row.status){
    if(live){
      await pool.query("UPDATE streams SET status='live',started_at=COALESCE(started_at,now()),updated_at=now() WHERE id=$1",[row.id]);
    }else{
      await pool.query("UPDATE streams SET status='offline',ended_at=now(),updated_at=now() WHERE id=$1",[row.id]);
    }
  }
  return {...row,status};
}
async function streamRows(){
  const r=await pool.query(`SELECT s.*,
    COALESCE((SELECT count(*) FROM stream_viewers v WHERE v.stream_id=s.id),0)::int AS total_viewers,
    COALESCE((SELECT count(*) FROM stream_viewers v WHERE v.stream_id=s.id AND v.last_seen>=now()-interval '45 seconds'),0)::int AS current_viewers,
    COALESCE((SELECT max(c) FROM (SELECT count(*)::int c FROM stream_viewers v WHERE v.stream_id=s.id GROUP BY date_trunc('minute',v.last_seen)) z),0)::int AS peak_viewers
    FROM streams s ORDER BY s.updated_at DESC`);
  const out=[];for(const row of r.rows)out.push(await refreshStreamStatus(row));
  return out;
}
app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

app.get("/health",(req,res)=>res.json({ok:true,service:"FBI Client File Studio",storage:s3Ready()?"railway-object-storage":"not-ready",time:new Date().toISOString()}));

app.post("/api/auth/login",async(req,res)=>{
  try{
    const email=String(req.body.email||"").trim().toLowerCase();
    const password=String(req.body.password||"");
    if(email!==ADMIN_EMAIL||!(await adminPasswordMatches(password)))return res.status(401).json({error:"Invalid email or password"});
    res.setHeader("Set-Cookie",`fbi_session=${encodeURIComponent(session(email))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
    res.json({ok:true,email});
  }catch(e){console.error(e);res.status(500).json({error:"Login service error"});}
});
app.post("/api/auth/logout",(req,res)=>{
  res.setHeader("Set-Cookie","fbi_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/auth/me",(req,res)=>res.json(validSession(req)?{authenticated:true,email:ADMIN_EMAIL}:{authenticated:false}));
app.post("/api/portal/register",async(req,res)=>{
 try{
  const fullName=String(req.body.full_name||"").trim().slice(0,120);
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(!fullName)return res.status(400).json({error:"Full name is required."});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({error:"Enter a valid email address."});
  if(password.length<10)return res.status(400).json({error:"Password must be at least 10 characters."});
  const existing=await pool.query("SELECT id FROM users WHERE email=$1",[email]);
  if(existing.rowCount)return res.status(409).json({error:"An account with that email already exists."});
  const id=uid(),hash=await hashUserPassword(password);
  const r=await pool.query("INSERT INTO users(id,email,full_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,full_name,created_at",[id,email,fullName,hash]);
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(r.rows[0]))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  res.json({ok:true,user:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create your account."})}
});
app.post("/api/portal/login",async(req,res)=>{
 try{
  const email=String(req.body.email||"").trim().toLowerCase(),password=String(req.body.password||"");
  const r=await pool.query("SELECT id,email,full_name,password_hash FROM users WHERE email=$1",[email]);
  if(!r.rowCount||!(await userPasswordMatches(password,r.rows[0].password_hash)))return res.status(401).json({error:"Invalid email or password."});
  const u={id:r.rows[0].id,email:r.rows[0].email,full_name:r.rows[0].full_name};
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(u))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  res.json({ok:true,user:u});
 }catch(e){console.error(e);res.status(500).json({error:"Login service error."})}
});
app.post("/api/portal/logout",(req,res)=>{
  res.setHeader("Set-Cookie","fbi_user_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/portal/me",portalUser,async(req,res)=>{
 try{
  const r=await pool.query("SELECT id,email,full_name,created_at FROM users WHERE id=$1",[req.portalUser.id]);
  if(!r.rowCount)return res.status(401).json({error:"Account not found."});
  res.json({authenticated:true,user:r.rows[0]});
 }catch(e){res.status(500).json({error:"Could not load account."})}
});

app.get("/api/portal/projects",portalUser,async(req,res)=>{
 try{
  const q=String(req.query.q||"").trim();
  const sql=q ? "SELECT p.*,COALESCE((SELECT count(*) FROM files f WHERE f.project_id=p.id),0)::int file_count,COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes FROM projects p WHERE p.owner_id=$1 AND (p.name ILIKE $2 OR p.client_name ILIKE $2) ORDER BY p.updated_at DESC" : "SELECT p.*,COALESCE((SELECT count(*) FROM files f WHERE f.project_id=p.id),0)::int file_count,COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes FROM projects p WHERE p.owner_id=$1 ORDER BY p.updated_at DESC";
  const vals=q?[req.portalUser.id,"%"+q+"%"]:[req.portalUser.id];
  const r=await pool.query(sql,vals);res.json({projects:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load your projects."})}
});
app.post("/api/portal/projects",portalUser,async(req,res)=>{
 try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Project name is required."});
  const id=uid(),shareToken=token(),settings=await loadSettings(),defaultNote=String(req.body.note||"").trim()||settings.default_client_note||"",days=settingInt(settings.default_expiry_days,30),expires=days?new Date(Date.now()+days*86400000):null;
  const r=await pool.query("INSERT INTO projects(id,owner_id,name,client_name,client_email,note,share_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",[id,req.portalUser.id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),defaultNote,shareToken,expires]);
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create project."})}
});
app.get("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const f=await pool.query("SELECT * FROM files WHERE project_id=$1 ORDER BY created_at DESC",[p.id]);res.json({project:p,files:f.rows});}
 catch(e){console.error(e);res.status(500).json({error:"Could not load project."})}
});
app.patch("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const fields=[],values=[];let n=1;for(const k of ["name","client_name","client_email","note","expires_at","shared","archived"])if(Object.prototype.hasOwnProperty.call(req.body,k)){fields.push(k+"=$"+n++);values.push(k==="shared"||k==="archived"?Boolean(req.body[k]):req.body[k]===null?null:String(req.body[k]).trim())}if(!fields.length)return res.status(400).json({error:"Nothing to update."});fields.push("updated_at=now()");values.push(p.id,req.portalUser.id);const r=await pool.query("UPDATE projects SET "+fields.join(",")+" WHERE id=$"+n+" AND owner_id=$"+(n+1)+" RETURNING *",values);if(!r.rowCount)return res.status(404).json({error:"Project not found."});res.json({project:r.rows[0]});}
 catch(e){console.error(e);res.status(500).json({error:"Could not update project."})}
});
app.post("/api/portal/projects/:id/share",portalUser,async(req,res)=>{
 try{const p=await portalProjectOwned(req.portalUser.id,req.params.id);if(!p)return res.status(404).json({error:"Project not found."});const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 AND owner_id=$3 RETURNING *",[token(),p.id,req.portalUser.id]);res.json({project:r.rows[0],share_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/share/"+r.rows[0].share_token});}
 catch(e){console.error(e);res.status(500).json({error:"Could not create client share link."})}
});
app.get("/api/portal/thumb/:id",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT * FROM files WHERE id=$1 AND project_id IN (SELECT id FROM projects WHERE owner_id=$2)",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).send("File not found.");
  const f=q.rows[0];
  const width=Math.max(160,Math.min(640,Number(req.query.w||360))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(f);
  const cacheKey="portal:"+f.id+":"+kind+":"+width+"x"+height, cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").send(cached.buffer);
  const key="__portal-thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+kind+"|"+width+"|"+height).digest("hex")+".webp";
  try{
   const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:key}));
   if(head.ContentLength){
    const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:key}));
    const bytes=got.Body?.transformToByteArray?Buffer.from(await got.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
    setThumbCache(cacheKey,bytes);return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").send(bytes);
   }
  }catch(_e){}
  const webp=await generateThumbnail(f,width,height);
  setThumbCache(cacheKey,webp);
  await s3.send(new PutObjectCommand({Bucket:bucket(),Key:key,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(f.id),generated_by:"fbi-client-file-studio-portal-media-aware"}})).catch(function(){});
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").send(webp);
 }catch(e){console.error(e);res.status(500).send("Unable to generate thumbnail.")}
});
app.delete("/api/portal/projects/:id",portalUser,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready."});
  const p=await portalProjectOwned(req.portalUser.id,req.params.id);
  if(!p)return res.status(404).json({error:"Project not found."});
  const files=await pool.query("SELECT storage_path FROM files WHERE project_id=$1",[p.id]);
  const sessions=await pool.query("SELECT storage_key,multipart_upload_id,mode FROM upload_sessions WHERE project_id=$1 AND status='active'",[p.id]);
  for(const u of sessions.rows){
   if(u.mode==="multipart"&&u.multipart_upload_id)await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(()=>{});
   else if(u.storage_key)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(()=>{});
  }
  const keys=files.rows.map(f=>f.storage_path).filter(Boolean);
  for(let i=0;i<keys.length;i+=1000){
   const out=await s3.send(new DeleteObjectsCommand({Bucket:bucket(),Delete:{Objects:keys.slice(i,i+1000).map(function(Key){return {Key:Key}}),Quiet:true}}));
   if(out.Errors&&out.Errors.length)throw new Error("One or more cloud files could not be deleted.");
  }
  await pool.query("DELETE FROM projects WHERE id=$1 AND owner_id=$2",[p.id,req.portalUser.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not completely delete the project."})}
});
app.get("/api/portal/file/:id",portalUser,async(req,res)=>{
 try{const r=await pool.query("SELECT * FROM files WHERE id=$1 AND project_id IN (SELECT id FROM projects WHERE owner_id=$2)",[req.params.id,req.portalUser.id]);if(!r.rowCount)return res.status(404).send("File not found.");const f=r.rows[0];const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:900});res.redirect(url);}
 catch(e){console.error(e);res.status(500).send("Unable to serve file.")}
});
app.get("/api/projects",admin,async(req,res)=>{
 try{
  const q=String(req.query.q||"").trim();
  const status=String(req.query.status||"active");
  const where=[],values=[];
  if(q){values.push(`%${q}%`);where.push(`(p.name ILIKE ${values.length} OR p.client_name ILIKE ${values.length} OR p.client_email ILIKE ${values.length})`);}
  if(status==="active")where.push("p.archived=false");
  if(status==="archived")where.push("p.archived=true");
  const r=await pool.query(`SELECT p.*,
    (SELECT count(*) FROM files f WHERE f.project_id=p.id) file_count,
    COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes
    FROM projects p ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY p.updated_at DESC`,values);
  res.json({projects:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load projects"})}
});

app.post("/api/projects",admin,async(req,res)=>{
 try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Project name is required"});
  const id=uid(),shareToken=token();
  const settings=await loadSettings();
  const defaultNote=String(req.body.note||"").trim()||settings.default_client_note||"";
  const days=settingInt(settings.default_expiry_days,30);
  const expires=days?new Date(Date.now()+days*86400000):null;
  const r=await pool.query("INSERT INTO projects(id,name,client_name,client_email,note,share_token,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),defaultNote,shareToken,expires]);
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create project"})}
});
app.get("/api/projects/:id",admin,async(req,res)=>{
 try{
  const p=await pool.query("SELECT * FROM projects WHERE id=$1",[req.params.id]);if(!p.rowCount)return res.status(404).json({error:"Project not found"});
  const f=await pool.query("SELECT * FROM files WHERE project_id=$1 ORDER BY created_at DESC",[req.params.id]);
  res.json({project:p.rows[0],files:f.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load project"})}
});
app.patch("/api/projects/:id",admin,async(req,res)=>{
 try{
  const allowed=["name","client_name","client_email","note","expires_at","shared","archived"];const fields=[],values=[];let n=1;
  for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body,k)){fields.push(`${k}=$${n++}`);values.push(k==="shared"||k==="archived"?Boolean(req.body[k]):req.body[k]===null?null:String(req.body[k]).trim())}
  if(!fields.length)return res.status(400).json({error:"Nothing to update"});
  fields.push("updated_at=now()");values.push(req.params.id);
  const r=await pool.query(`UPDATE projects SET ${fields.join(",")} WHERE id=$${n} RETURNING *`,values);if(!r.rowCount)return res.status(404).json({error:"Project not found"});
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not update project"})}
});
app.delete("/api/projects/:id",admin,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready."});
  const project=await pool.query("SELECT id,name FROM projects WHERE id=$1",[req.params.id]);
  if(!project.rowCount)return res.status(404).json({error:"Project not found"});
  const files=await pool.query("SELECT id,storage_path FROM files WHERE project_id=$1",[req.params.id]);
  const sessions=await pool.query("SELECT id,storage_key,multipart_upload_id,mode FROM upload_sessions WHERE project_id=$1 AND status='active'",[req.params.id]);
  for(const u of sessions.rows){
    if(u.mode==="multipart"&&u.multipart_upload_id){
      await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
    }else if(u.storage_key){
      await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
    }
  }
  const keys=files.rows.map(f=>f.storage_path).filter(Boolean);
  for(let i=0;i<keys.length;i+=1000){
    const batch=keys.slice(i,i+1000);
    const out=await s3.send(new DeleteObjectsCommand({Bucket:bucket(),Delete:{Objects:batch.map(function(Key){return {Key:Key}}),Quiet:true}}));
    if(out.Errors&&out.Errors.length)throw new Error("Cloud storage could not delete one or more project files.");
  }
  await pool.query("DELETE FROM projects WHERE id=$1",[req.params.id]);
  res.json({ok:true,deleted_project_id:req.params.id,deleted_file_count:files.rowCount,project_name:project.rows[0].name});
 }catch(e){
  console.error("Project deletion failed:",e?.stack||e);
  res.status(500).json({error:"Could not completely delete the project. No database records were removed."});
 }
});

app.post("/api/projects/:id/regenerate-link",admin,async(req,res)=>{
 try{
  const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 RETURNING *",[token(),req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Project not found"});
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create share link"})}
});





app.post("/api/stream/auth",async(req,res)=>{
  try{
    const action=String(req.body.action||"");
    const pathValue=String(req.body.path||"").replace(/^\/+|\/+$/g,"");
    const query=parseQueryString(req.body.query);
    const presentedToken=String(req.body.token||query.token||"");
    const presentedPassword=String(req.body.password||"");
    if(!pathValue)return res.status(401).end();
    // MediaMTX authenticates not only the parent HLS path (live/<key>)
    // but also child playlists and media segments such as
    // live/<key>/video1_stream.m3u8. Resolve both the exact stream path
    // and any descendant path to the same stream record.
    const r=await pool.query(
      "SELECT * FROM streams WHERE stream_path=$1 OR $1 LIKE stream_path || '/%' ORDER BY length(stream_path) DESC LIMIT 1",
      [pathValue]
    );
    if(!r.rowCount)return res.status(403).end();
    const stream=r.rows[0];
    if(action==="publish"){
      const pathMatches=pathValue===stream.stream_path;
      if(!stream.enabled || (!pathMatches && presentedPassword!==stream.stream_key && presentedToken!==stream.stream_key))return res.status(403).end();
      await pool.query("UPDATE streams SET updated_at=now() WHERE id=$1",[stream.id]);
      return res.status(200).end();
    }
    if(action==="read"||action==="playback"){
      if(!stream.enabled || !stream.shared)return res.status(403).end();
      return res.status(200).end();
    }
    if(action==="api"||action==="metrics"||action==="pprof")return res.status(200).end();
    return res.status(403).end();
  }catch(e){console.error(e);res.status(500).end();}
});

app.get("/api/streams",admin,async(req,res)=>{
  try{
    const rows=await streamRows();
    const rtmpHost=String(process.env.STREAM_RTMP_HOST||"");
    const rtmpPort=String(process.env.STREAM_RTMP_PORT||"");
    res.json({streams:rows.map(s=>({
      ...s,
      stream_key:s.stream_key,
      stream_path:s.stream_path,
      rtmp_server:rtmpHost&&rtmpPort?`rtmp://${rtmpHost}:${rtmpPort}/live`:"",
      hls_url:streamHlsUrl(s),
      viewer_url:(PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`)+"/watch/"+s.viewer_token
    }))});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load live streams"});}
});

app.post("/api/streams",admin,async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name)return res.status(400).json({error:"Stream name is required."});
    const key=randomStreamKey(),viewer=randomViewerToken();
    const r=await pool.query(
      "INSERT INTO streams(id,name,title,description,stream_key,stream_path,viewer_token,shared,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,true,true) RETURNING *",
      [uid(),name,String(req.body.title||name).trim(),String(req.body.description||"").trim(),key,streamPathForKey(key),viewer]
    );
    res.json({stream:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create stream"});}
});

app.get("/api/streams/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM streams WHERE id=$1",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found."});
    const s=await refreshStreamStatus(r.rows[0]);
    const viewers=await pool.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE last_seen>=now()-interval '45 seconds')::int AS current FROM stream_viewers WHERE stream_id=$1",[s.id]);
    res.json({stream:{...s,rtmp_server:(process.env.STREAM_RTMP_HOST&&process.env.STREAM_RTMP_PORT)?`rtmp://${process.env.STREAM_RTMP_HOST}:${process.env.STREAM_RTMP_PORT}/live`:"",hls_url:streamHlsUrl(s),viewer_url:(PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`)+"/watch/"+s.viewer_token},viewers:viewers.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load stream"});}
});

app.patch("/api/streams/:id",admin,async(req,res)=>{
  try{
    const allowed=["name","title","description","shared","enabled"];
    const fields=[],values=[];let n=1;
    for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body,k)){
      fields.push(`${k}=${n++}`);
      values.push(k==="shared"||k==="enabled"?Boolean(req.body[k]):String(req.body[k]??"").trim().slice(0,2000));
    }
    if(!fields.length)return res.status(400).json({error:"Nothing to update"});
    fields.push("updated_at=now()");values.push(req.params.id);
    const r=await pool.query(`UPDATE streams SET ${fields.join(",")} WHERE id=${n} RETURNING *`,values);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    res.json({stream:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not update stream"});}
});

app.post("/api/streams/:id/regenerate-key",admin,async(req,res)=>{
  try{
    const key=randomStreamKey();
    const r=await pool.query("UPDATE streams SET stream_key=$1,stream_path=$2,updated_at=now(),status='offline',started_at=NULL,ended_at=now() WHERE id=$3 RETURNING *",[key,streamPathForKey(key),req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    res.json({stream:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not regenerate stream key"});}
});

app.delete("/api/streams/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("DELETE FROM streams WHERE id=$1 RETURNING id",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete stream"});}
});

app.post("/api/ndi/gateway/pair",admin,async(req,res)=>{
  try{
    const name=String(req.body.name||"FBI NDI Gateway").trim().slice(0,120)||"FBI NDI Gateway";
    const pair=randomNdiPairToken();
    const r=await pool.query("INSERT INTO ndi_gateways(id,name,pair_token,status,last_seen) VALUES($1,$2,$3,'pending',now()) RETURNING id,name,pair_token,status,created_at",[uid(),name,pair]);
    res.json({gateway:r.rows[0],studio_url:PUBLIC_BASE_URL||req.protocol+"://"+req.get("host")});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create NDI pairing code"});}
});

app.get("/api/ndi/gateways",admin,async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name,version,capabilities,status,active_input,active_output,last_ip,last_seen,created_at,updated_at FROM ndi_gateways ORDER BY updated_at DESC");
    const rows=r.rows.map(g=>({...g,status:(g.last_seen&&Date.now()-new Date(g.last_seen).getTime()<30000)?(g.status||"connected"):"offline"}));
    res.json({gateways:rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load NDI gateways"});}
});

app.delete("/api/ndi/gateway/:id",admin,async(req,res)=>{
  try{
    const r=await pool.query("DELETE FROM ndi_gateways WHERE id=$1 RETURNING id",[req.params.id]);
    if(!r.rowCount)return res.status(404).json({error:"Gateway not found"});
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Could not remove gateway"});}
});

app.post("/api/ndi/gateway/:pairToken/register",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name FROM ndi_gateways WHERE pair_token=$1",[req.params.pairToken]);
    if(!r.rowCount)return res.status(403).json({error:"Invalid NDI pairing code"});
    const caps=req.body.capabilities&&typeof req.body.capabilities==="object"?req.body.capabilities:{};
    const name=String(req.body.name||r.rows[0].name||"FBI NDI Gateway").trim().slice(0,120);
    await pool.query("UPDATE ndi_gateways SET name=$1,version=$2,capabilities=$3,status='connected',last_ip=$4,last_seen=now(),updated_at=now() WHERE id=$5",[name,String(req.body.version||"").slice(0,80),JSON.stringify(caps),clientIp(req),r.rows[0].id]);
    res.json({ok:true,gateway_id:r.rows[0].id,studio_url:PUBLIC_BASE_URL||req.protocol+"://"+req.get("host")});
  }catch(e){console.error(e);res.status(500).json({error:"NDI gateway registration failed"});}
});

app.get("/api/ndi/gateway/:pairToken/config",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id,name,status FROM ndi_gateways WHERE pair_token=$1",[req.params.pairToken]);
    if(!r.rowCount)return res.status(403).json({error:"Invalid NDI pairing code"});
    const streams=await streamRows();
    res.json({
      gateway:{id:r.rows[0].id,name:r.rows[0].name,status:r.rows[0].status},
      studio_url:PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"),
      rtmp_server:streamRtmpServer(),
      streams:streams.map(s=>({id:s.id,name:s.name,title:s.title,stream_key:s.stream_key,stream_path:s.stream_path,shared:s.shared,enabled:s.enabled,hls_url:streamHlsUrl(s),viewer_url:(PUBLIC_BASE_URL||req.protocol+"://"+req.get("host"))+"/watch/"+s.viewer_token}))
    });
  }catch(e){console.error(e);res.status(500).json({error:"Could not load NDI gateway configuration"});}
});

app.post("/api/ndi/gateway/:pairToken/heartbeat",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id FROM ndi_gateways WHERE pair_token=$1",[req.params.pairToken]);
    if(!r.rowCount)return res.status(403).json({error:"Invalid NDI pairing code"});
    const state=req.body&&typeof req.body==="object"?req.body:{};
    await pool.query("UPDATE ndi_gateways SET status=$1,active_input=$2,active_output=$3,last_ip=$4,last_seen=now(),updated_at=now() WHERE id=$5",[String(state.status||"connected").slice(0,40),String(state.active_input||"").slice(0,200),String(state.active_output||"").slice(0,200),clientIp(req),r.rows[0].id]);
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"NDI heartbeat failed"});}
});

app.post("/api/public/stream/:token/heartbeat",async(req,res)=>{
  try{
    const r=await pool.query("SELECT id FROM streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[req.params.token]);
    if(!r.rowCount)return res.status(404).json({error:"Stream not found"});
    const sessionKey=String(req.body.sessionKey||"").slice(0,120);
    if(!sessionKey)return res.status(400).json({error:"Session key required"});
    const existing=await pool.query("SELECT id FROM stream_viewers WHERE stream_id=$1 AND session_key=$2",[r.rows[0].id,sessionKey]);
    if(existing.rowCount){
      await pool.query("UPDATE stream_viewers SET last_seen=now(),ended_at=NULL,user_agent=$1,ip_address=$2 WHERE id=$3",[String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req),existing.rows[0].id]);
    }else{
      await pool.query("INSERT INTO stream_viewers(id,stream_id,session_key,user_agent,ip_address) VALUES($1,$2,$3,$4,$5)",[uid(),r.rows[0].id,sessionKey,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req)]);
    }
    res.json({ok:true});
  }catch(e){res.status(500).json({error:"Heartbeat failed"});}
});

app.get("/api/public/stream/:token/status",async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[req.params.token]);
    if(!r.rowCount)return res.status(404).json({error:"This stream link is invalid, disabled, or expired."});
    const s=await refreshStreamStatus(r.rows[0]);
    const v=await pool.query("SELECT count(*)::int AS current FROM stream_viewers WHERE stream_id=$1 AND last_seen>=now()-interval '45 seconds'",[s.id]);
    res.json({live:s.status==="live",title:s.title,name:s.name,current_viewers:v.rows[0].current});
  }catch(e){res.status(500).json({error:"Could not load stream status"});}
});

app.get("/watch/:token",async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM streams WHERE viewer_token=$1 AND enabled=true AND shared=true",[req.params.token]);
    if(!r.rowCount)return res.status(404).send("Stream link is invalid or disabled.");
    const s=r.rows[0], hls=streamHlsUrl(s)+"/index.m3u8";
    const title=escHtml(s.title||s.name), base=PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`;
    const logo=(base||"")+"/__fbi_logo.svg";
    const tokenJs=JSON.stringify(req.params.token);
    res.type("html").send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} • FBI Live</title><script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script><style>body{margin:0;background:#09090a;color:#f6f6f7;font-family:Inter,system-ui,sans-serif;min-height:100vh}.wrap{max-width:1100px;margin:auto;padding:20px}.head{text-align:center;padding:18px}.head h1{font-size:24px;margin:10px 0 5px}.head p{color:#9b9ba4;margin:0;font-size:12px}.player{background:#111;border:1px solid #29292e;border-radius:16px;overflow:hidden;min-height:320px;box-shadow:0 20px 70px rgba(0,0,0,.35);position:relative}.player video{display:block;width:100%;height:min(70vh,620px);background:#000}.offline{display:grid;place-items:center;min-height:360px;color:#9b9ba4;text-align:center;padding:20px}.badge{display:inline-block;padding:5px 9px;border-radius:999px;border:1px solid #29292e;font-size:10px}.live{color:#4ade80;border-color:rgba(74,222,128,.3);background:rgba(74,222,128,.05)}.error{color:#fb7185}.foot{text-align:center;color:#66666e;font-size:9px;padding:18px}</style></head><body><div class="wrap"><div class="head"><div class="badge" id="status">Checking live status…</div><h1>${title}</h1><p id="viewers">FBI Live Stream</p></div><div class="player"><video id="video" controls playsinline autoplay muted></video><div id="offline" class="offline" style="display:none"></div></div><div class="foot">FILM BEYOND IMAGINATION • FBI Live</div></div><script>
const token=${tokenJs};const hlsUrl=${JSON.stringify(hls)};const video=document.getElementById("video");const offline=document.getElementById("offline");const statusEl=document.getElementById("status");const viewers=document.getElementById("viewers");const sessionKey=crypto.randomUUID();let player=null;let live=false;
function stopPlayer(){if(player){try{player.destroy()}catch{}player=null}try{video.pause();video.removeAttribute("src");video.load()}catch{} }
function startPlayer(){stopPlayer();offline.style.display="none";video.style.display="block";if(video.canPlayType("application/vnd.apple.mpegurl")){video.src=hlsUrl;video.play().catch(()=>{});return}if(window.Hls&&Hls.isSupported()){player=new Hls({enableWorker:true,lowLatencyMode:true,maxLiveSyncPlaybackRate:1.5});player.on(Hls.Events.ERROR,function(_,data){if(data&&data.fatal){statusEl.textContent="PLAYBACK ERROR";statusEl.className="badge error";viewers.textContent="The stream is live, but the browser could not load the media. Retrying…";try{player.destroy()}catch{}player=null}});player.loadSource(hlsUrl);player.attachMedia(video);player.on(Hls.Events.MANIFEST_PARSED,function(){video.play().catch(()=>{})});return}video.style.display="none";offline.style.display="grid";offline.textContent="This browser does not support HLS playback."}
async function refresh(){try{const r=await fetch("/api/public/stream/"+encodeURIComponent(token)+"/status",{cache:"no-store"});const d=await r.json();if(!r.ok)throw new Error(d.error);statusEl.textContent=d.live?"● LIVE":"OFFLINE";statusEl.className="badge "+(d.live?"live":"");viewers.textContent=d.live?(d.current_viewers||0)+" watching now":"Waiting for the stream to start";if(d.live){if(!live){live=true;startPlayer()}await fetch("/api/public/stream/"+encodeURIComponent(token)+"/heartbeat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionKey})});}else{if(live){live=false;stopPlayer()}offline.style.display="grid";offline.textContent="Waiting for the stream to start…";video.style.display="none";}}catch(e){statusEl.textContent="STREAM UNAVAILABLE";statusEl.className="badge error";viewers.textContent=e.message;}}
refresh();setInterval(refresh,10000);
</script></body></html>`);
  }catch(e){res.status(500).send("Could not load stream.");}
});
app.get("/api/storage",admin,async(req,res)=>{
  try{
    const r=await pool.query(`
      SELECT
        COALESCE((SELECT sum(size_bytes) FROM files),0)::numeric AS used_bytes,
        COALESCE((SELECT sum(size_bytes) FROM upload_sessions WHERE status='active' AND updated_at>=now()-interval '7 days'),0)::numeric AS reserved_bytes,
        (SELECT count(*) FROM files)::int AS file_count,
        (SELECT count(*) FROM projects WHERE archived=false)::int AS project_count
    `);
    const row=r.rows[0]||{};
    const used=Number(row.used_bytes||0);
    const reserved=Number(row.reserved_bytes||0);
    const quota=Math.max(0,Number(STORAGE_QUOTA_BYTES||0));
    const available=Math.max(0,quota-used-reserved);
    const percent=quota?Math.min(100,((used+reserved)/quota)*100):0;
    res.json({
      storage:{
        quota_bytes:quota,
        used_bytes:used,
        reserved_bytes:reserved,
        available_bytes:available,
        usage_percent:percent,
        file_count:Number(row.file_count||0),
        project_count:Number(row.project_count||0),
        format_quota:formatStorageBytes(quota),
        format_used:formatStorageBytes(used),
        format_reserved:formatStorageBytes(reserved),
        format_available:formatStorageBytes(available),
        storage_ready:s3Ready(),
        bucket_name:String(process.env.S3_BUCKET||""),
        bucket_region:String(process.env.S3_REGION||"")
      }
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"Could not load storage information"});
  }
});

app.get("/api/dashboard",admin,async(req,res)=>{
  try{
    const [counts,recentProjects,recentDownloads,typeRows]=await Promise.all([
      pool.query(`SELECT
        (SELECT count(*) FROM projects WHERE archived=false) active_projects,
        (SELECT count(*) FROM projects WHERE archived=true) archived_projects,
        (SELECT count(*) FROM projects WHERE shared=true AND archived=false) shared_projects,
        (SELECT count(*) FROM files) file_count,
        COALESCE((SELECT sum(size_bytes) FROM files),0) storage_bytes,
        ${STORAGE_QUOTA_BYTES}::numeric storage_quota_bytes,
        GREATEST(0,${STORAGE_QUOTA_BYTES}::numeric-COALESCE((SELECT sum(size_bytes) FROM files),0)) storage_available_bytes,
        (SELECT count(*) FROM downloads) download_count,
        (SELECT count(*) FROM downloads WHERE downloaded_at>=now()-interval '7 days') downloads_7d,
        (SELECT count(*) FROM downloads WHERE downloaded_at>=now()-interval '30 days') downloads_30d`),
      pool.query(`SELECT p.*,
        (SELECT count(*) FROM files f WHERE f.project_id=p.id) file_count,
        COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes
        FROM projects p ORDER BY p.updated_at DESC LIMIT 8`),
      pool.query(`SELECT d.id,d.downloaded_at,d.ip_address,d.user_agent,
        p.name project_name,f.original_name,f.size_bytes,f.mime_type
        FROM downloads d
        LEFT JOIN projects p ON p.id=d.project_id
        LEFT JOIN files f ON f.id=d.file_id
        ORDER BY d.downloaded_at DESC LIMIT 10`),
      pool.query(`SELECT
        CASE
          WHEN mime_type LIKE 'video/%' THEN 'Video'
          WHEN mime_type LIKE 'image/%' THEN 'Photo'
          WHEN mime_type LIKE 'audio/%' THEN 'Audio'
          WHEN mime_type='application/pdf' THEN 'PDF'
          WHEN mime_type LIKE 'application/zip%' OR mime_type LIKE '%compressed%' THEN 'Archive'
          ELSE 'Other'
        END AS type,
        count(*)::int AS files,
        COALESCE(sum(size_bytes),0) AS bytes
        FROM files GROUP BY 1 ORDER BY bytes DESC`)
    ]);
    res.json({summary:counts.rows[0],recentProjects:recentProjects.rows,recentDownloads:recentDownloads.rows,types:typeRows.rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load dashboard"})}
});

app.get("/api/downloads",admin,async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const limit=Math.max(1,Math.min(250,Number(req.query.limit||100)));
    const where=[],values=[];
    if(q){values.push(`%${q}%`);where.push(`(p.name ILIKE ${values.length} OR f.original_name ILIKE ${values.length} OR d.ip_address ILIKE ${values.length})`);}
    values.push(limit);
    const r=await pool.query(`SELECT d.id,d.downloaded_at,d.ip_address,d.user_agent,
      p.name project_name,f.original_name,f.size_bytes,f.mime_type
      FROM downloads d
      LEFT JOIN projects p ON p.id=d.project_id
      LEFT JOIN files f ON f.id=d.file_id
      ${where.length?"WHERE "+where.join(" AND "):""}
      ORDER BY d.downloaded_at DESC LIMIT ${values.length}`,values);
    res.json({downloads:r.rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load download records"})}
});

app.get("/api/settings",admin,async(req,res)=>{
  try{
    const settings=await loadSettings();
    res.json({
      settings:{
        studio_name:settings.studio_name,
        portal_title:settings.portal_title,
        default_client_note:settings.default_client_note,
        default_expiry_days:settingInt(settings.default_expiry_days,30),
        log_downloads:settingBool(settings.log_downloads),
        allow_client_preview:settingBool(settings.allow_client_preview),
        show_file_size:settingBool(settings.show_file_size)
      },
      infrastructure:{
        storage: s3Ready(),
        database: !!process.env.DATABASE_URL,
        public_url: PUBLIC_BASE_URL || null
      }
    });
  }catch(e){console.error(e);res.status(500).json({error:"Could not load settings"})}
});

app.patch("/api/settings",admin,async(req,res)=>{
  try{
    const allowed={
      studio_name:String(req.body.studio_name??"FBI Client File Studio").trim().slice(0,120)||"FBI Client File Studio",
      portal_title:String(req.body.portal_title??"FBI Client File Delivery").trim().slice(0,120)||"FBI Client File Delivery",
      default_client_note:String(req.body.default_client_note??"").trim().slice(0,1000),
      default_expiry_days:String(settingInt(req.body.default_expiry_days,30)),
      log_downloads:String(Boolean(req.body.log_downloads)),
      allow_client_preview:String(Boolean(req.body.allow_client_preview)),
      show_file_size:String(Boolean(req.body.show_file_size))
    };
    for(const [key,value] of Object.entries(allowed)){
      await pool.query(`INSERT INTO app_settings(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[key,value]);
    }
    res.json({ok:true,settings:allowed});
  }catch(e){console.error(e);res.status(500).json({error:"Could not save settings"})}
});

app.post("/api/settings/password",admin,async(req,res)=>{
  try{
    const current=String(req.body.current_password||"");
    const next=String(req.body.new_password||"");
    if(next.length<10)return res.status(400).json({error:"New password must be at least 10 characters."});
    if(!(await adminPasswordMatches(current)))return res.status(401).json({error:"Current password is incorrect."});
    const hash=await hashAdminPassword(next);
    await pool.query(`INSERT INTO app_settings(key,value) VALUES('admin_password_hash',$1) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,[hash]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not change password"})}
});

app.post("/api/portal/uploads/init",portalUser,async(req,res)=>{
 try{
  if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
  const projectId=String(req.body.projectId||""),originalName=String(req.body.name||"").trim(),relativePath=safeRelativePath(req.body.relativePath,originalName),size=Number(req.body.size||0),mimeType=String(req.body.mimeType||"application/octet-stream"),fingerprint=String(req.body.fingerprint||"").trim().slice(0,128);
  const project=await portalProjectOwned(req.portalUser.id,projectId);
  if(!project)return res.status(404).json({error:"Project not found."});
  if(!originalName||!Number.isFinite(size)||size<0||size>MAX_FILE_SIZE)return res.status(400).json({error:"Invalid file."});
  if(fingerprint){
   const dup=await pool.query("SELECT * FROM files WHERE project_id=$1 AND content_fingerprint=$2 AND size_bytes=$3 LIMIT 1",[projectId,fingerprint,size]);
   if(dup.rowCount)return res.json({uploadId:null,deduplicated:true,mode:"deduplicated",size:size,file:dup.rows[0]});
  }
  const id=uid(),partSize=choosePartSize(size||1),mode=size>=MIN_PART_SIZE?"multipart":"single",storageKey="projects/"+projectId+"/"+id+"/"+relativePath;
  let multipartUploadId=null,url=null;
  if(mode==="multipart"){
   const created=await s3.send(new CreateMultipartUploadCommand({Bucket:bucket(),Key:storageKey,ContentType:mimeType}));
   multipartUploadId=created.UploadId;
  }else{
   url=await getSignedUrl(s3,new PutObjectCommand({Bucket:bucket(),Key:storageKey,ContentType:mimeType}),{expiresIn:3600});
  }
  await pool.query("INSERT INTO upload_sessions(id,project_id,original_name,relative_path,storage_key,mime_type,size_bytes,part_size,multipart_upload_id,mode,status,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)",[id,projectId,originalName,relativePath,storageKey,mimeType,size,mode==="multipart"?partSize:size,multipartUploadId,mode,fingerprint||null]);
  res.json({uploadId:id,mode:mode,partSize:mode==="multipart"?partSize:size,size:size,url:url,multipartUploadId:multipartUploadId});
 }catch(e){console.error(e);res.status(500).json({error:"Could not initialize cloud upload."})}
});
app.get("/api/portal/uploads/:id/state",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  if(u.mode!=="multipart")return res.json({uploadId:u.id,mode:u.mode,status:u.status,parts:[]});
  const parts=[];let marker=0;
  while(true){
   const r=await s3.send(new ListPartsCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumberMarker:marker||undefined,MaxParts:1000}));
   for(const p of r.Parts||[])parts.push({partNumber:p.PartNumber,etag:p.ETag,size:p.Size});
   if(!r.IsTruncated)break;marker=r.NextPartNumberMarker;
  }
  res.json({uploadId:u.id,mode:u.mode,status:u.status,partSize:Number(u.part_size),size:Number(u.size_bytes),parts:parts});
 }catch(e){console.error(e);res.status(500).json({error:"Could not read upload state."})}
});
app.post("/api/portal/uploads/:id/parts",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  if(u.mode!=="multipart"||!u.multipart_upload_id)return res.status(400).json({error:"This upload does not use multipart storage."});
  const requested=(Array.isArray(req.body.parts)?req.body.parts:[]).map(function(x){return {partNumber:Number(x.partNumber)}}).filter(function(x){return Number.isInteger(x.partNumber)&&x.partNumber>0&&x.partNumber<=MAX_PARTS});
  if(!requested.length||requested.length>25)return res.status(400).json({error:"Provide 1 to 25 part numbers."});
  const parts=await Promise.all(requested.map(async function(x){
   const partUrl=await getSignedUrl(s3,new UploadPartCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumber:x.partNumber}),{expiresIn:PRESIGN_SECONDS});
   return {partNumber:x.partNumber,url:partUrl,checksum:null};
  }));
  res.json({parts:parts,expiresIn:PRESIGN_SECONDS});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create upload URLs."})}
});
app.post("/api/portal/uploads/:id/complete",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  if(u.mode==="multipart"){
   const parts=(Array.isArray(req.body.parts)?req.body.parts:[]).map(function(p){return {ETag:String(p.etag||p.ETag||"").replace(/^"+|"+$/g,""),PartNumber:Number(p.partNumber||p.PartNumber)}}).filter(function(p){return p.ETag&&Number.isInteger(p.PartNumber)}).sort(function(a,b){return a.PartNumber-b.PartNumber});
   if(!parts.length)return res.status(400).json({error:"Multipart upload has no completed parts."});
   await s3.send(new CompleteMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,MultipartUpload:{Parts:parts}}));
  }else await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:u.storage_key}));
  const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:u.storage_key})),actualSize=Number(head.ContentLength||0);
  if(actualSize!==Number(u.size_bytes))return res.status(400).json({error:"Uploaded size mismatch."});
  const fileId=uid();
  const ins=await pool.query("INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",[fileId,u.project_id,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,actualSize,u.relative_path,u.content_fingerprint||null]);
  await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
  await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
  res.json({ok:true,file:ins.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not complete upload. The upload can be resumed."})}
});
app.post("/api/portal/uploads/:id/abort",portalUser,async(req,res)=>{
 try{
  const q=await pool.query("SELECT u.* FROM upload_sessions u JOIN projects p ON p.id=u.project_id WHERE u.id=$1 AND p.owner_id=$2",[req.params.id,req.portalUser.id]);
  if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
  const u=q.rows[0];
  if(u.mode==="multipart"&&u.multipart_upload_id)await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
  else await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
  await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not cancel upload."})}
});
app.post("/api/uploads/init",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var projectId=String(req.body.projectId||"");
    var originalName=String(req.body.name||"").trim();
    var relativePath=safeRelativePath(req.body.relativePath,originalName);
    var size=Number(req.body.size||0);
    var mimeType=String(req.body.mimeType||"application/octet-stream");
    var fingerprint=String(req.body.fingerprint||"").trim().slice(0,128);
    var checksum=String(req.body.checksum||"").trim().slice(0,128);
    if(!projectId||!originalName)return res.status(400).json({error:"Project and file name are required."});
    if(!Number.isFinite(size)||size<0||size>MAX_FILE_SIZE)return res.status(400).json({error:"File size is outside the supported range."});
    var pr=await pool.query("SELECT id FROM projects WHERE id=$1 AND archived=false",[projectId]);
    if(!pr.rowCount)return res.status(404).json({error:"Project not found."});

    var existing=await pool.query(
      "SELECT * FROM upload_sessions WHERE project_id=$1 AND original_name=$2 AND relative_path=$3 AND size_bytes=$4 AND status='active' ORDER BY created_at DESC LIMIT 1",
      [projectId,originalName,relativePath,size]
    );
    if(existing.rowCount){
      var u=existing.rows[0];
      if(u.mode==="multipart"){
        return res.json({
          uploadId:u.id,mode:u.mode,partSize:Number(u.part_size),size:Number(u.size_bytes),
          multipartUploadId:u.multipart_upload_id,resumed:true
        });
      }
      var singleUrl=await getSignedUrl(
        s3,
        new PutObjectCommand({Bucket:bucket(),Key:u.storage_key,ContentType:u.mime_type}),
        {expiresIn:3600}
      );
      return res.json({uploadId:u.id,mode:"single",size:Number(u.size_bytes),url:singleUrl,resumed:true});
    }

    if(fingerprint){
      var dup=await pool.query(
        "SELECT * FROM files WHERE project_id=$1 AND content_fingerprint=$2 AND size_bytes=$3 ORDER BY created_at DESC LIMIT 1",
        [projectId,fingerprint,size]
      );
      if(dup.rowCount){
        return res.json({uploadId:null,deduplicated:true,resumed:false,mode:"deduplicated",size:size,file:dup.rows[0]});
      }
    }
    var usage=await pool.query(
      "SELECT COALESCE((SELECT sum(size_bytes) FROM files),0)::numeric stored, COALESCE((SELECT sum(size_bytes) FROM upload_sessions WHERE status='active' AND updated_at>=now()-interval '7 days'),0)::numeric reserved"
    );
    var stored=Number(usage.rows[0]?.stored||0),reserved=Number(usage.rows[0]?.reserved||0);
    if(stored+reserved+size>STORAGE_QUOTA_BYTES){
      return res.status(413).json({error:"Studio storage quota reached.",quotaBytes:STORAGE_QUOTA_BYTES,usedBytes:stored,reservedBytes:reserved,availableBytes:Math.max(0,STORAGE_QUOTA_BYTES-stored-reserved)});
    }
    var id=uid();
    var partSize=choosePartSize(size||1);
    var mode=size>=MIN_PART_SIZE?"multipart":"single";
    var storageKey="projects/"+projectId+"/"+id+"/"+relativePath;
    var multipartUploadId=null;
    var url=null;
    if(mode==="multipart"){
      var created=await s3.send(new CreateMultipartUploadCommand({
        Bucket:bucket(),Key:storageKey,ContentType:mimeType,ChecksumAlgorithm:"SHA256"
      }));
      multipartUploadId=created.UploadId;
    }else{
      var putInput={Bucket:bucket(),Key:storageKey,ContentType:mimeType};
      if(checksum)putInput.ChecksumSHA256=checksum;
      url=await getSignedUrl(s3,new PutObjectCommand(putInput),{expiresIn:3600});
    }
    await pool.query(
      "INSERT INTO upload_sessions(id,project_id,original_name,relative_path,storage_key,mime_type,size_bytes,part_size,multipart_upload_id,mode,status,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)",
      [id,projectId,originalName,relativePath,storageKey,mimeType,size,mode==="multipart"?partSize:size,multipartUploadId,mode,fingerprint||null]
    );
    res.json({uploadId:id,mode,partSize,size,url,multipartUploadId,checksum:checksum||null,fingerprint:fingerprint||null});
  }catch(e){console.error(e);res.status(500).json({error:"Could not initialize cloud upload."})}
});

app.get("/api/uploads/:id/state",admin,async(req,res)=>{
  try{
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    if(u.mode!=="multipart")return res.json({uploadId:u.id,mode:u.mode,status:u.status,parts:[]});
    var parts=[];
    var marker=0;
    while(true){
      var r=await s3.send(new ListPartsCommand({
        Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
        PartNumberMarker:marker||undefined,MaxParts:1000
      }));
      for(var i=0;i<(r.Parts||[]).length;i++){
        var p=r.Parts[i];
        parts.push({partNumber:p.PartNumber,etag:p.ETag,size:p.Size});
      }
      if(!r.IsTruncated)break;
      marker=r.NextPartNumberMarker;
    }
    res.json({uploadId:u.id,mode:u.mode,status:u.status,partSize:Number(u.part_size),size:Number(u.size_bytes),parts:parts});
  }catch(e){console.error(e);res.status(500).json({error:"Could not read upload state."})}
});

app.post("/api/uploads/:id/parts",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    if(u.mode!=="multipart"||!u.multipart_upload_id)return res.status(400).json({error:"This upload does not use multipart storage."});
    var requested=Array.isArray(req.body.parts)?req.body.parts.map(function(x){return {partNumber:Number(x.partNumber),checksum:String(x.checksum||"").trim()};}):[];
    if(!requested.length&&Array.isArray(req.body.partNumbers)){
      requested=req.body.partNumbers.map(function(n){return {partNumber:Number(n),checksum:""};});
    }
    requested=requested.filter(function(x){return Number.isInteger(x.partNumber)&&x.partNumber>0&&x.partNumber<=MAX_PARTS;});
    if(!requested.length||requested.length>25)return res.status(400).json({error:"Provide 1 to 25 part numbers."});
    var parts=[];
    for(var i=0;i<requested.length;i++){
      var partNumber=requested[i].partNumber;
      var checksum=requested[i].checksum;
      var commandInput={Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,PartNumber:partNumber};
      if(checksum)commandInput.ChecksumSHA256=checksum;
      var partUrl=await getSignedUrl(s3,new UploadPartCommand(commandInput),{expiresIn:PRESIGN_SECONDS});
      parts.push({partNumber:partNumber,url:partUrl,checksum:checksum||null});
    }
    res.json({parts:parts,expiresIn:PRESIGN_SECONDS});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create upload URLs."})}
});

app.post("/api/uploads/:id/complete",admin,async(req,res)=>{
  try{
    if(!s3Ready())return res.status(503).json({error:"Cloud storage is not ready."});
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    if(u.status==="completed"){
      var done=await pool.query("SELECT * FROM files WHERE storage_path=$1",[u.storage_key]);
      return res.json({ok:true,file:done.rows[0]||null,alreadyCompleted:true});
    }
    if(u.mode==="multipart"){
      var incoming=Array.isArray(req.body.parts)?req.body.parts:[];
      var parts=incoming.map(function(p){
        return {ETag:String(p.etag||p.ETag||"").replace(/^"+|"+$/g,""),PartNumber:Number(p.partNumber||p.PartNumber)};
      }).filter(function(p){return p.ETag&&Number.isInteger(p.PartNumber)&&p.PartNumber>0;})
        .sort(function(a,b){return a.PartNumber-b.PartNumber;});
      if(!parts.length)return res.status(400).json({error:"Multipart upload has no completed parts."});
      var seen=new Set(parts.map(function(p){return p.PartNumber;}));
      if(seen.size!==parts.length)return res.status(400).json({error:"Duplicate multipart part."});
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id,
        MultipartUpload:{Parts:parts}
      }));
    }else{
      await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:u.storage_key}));
    }
    var head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:u.storage_key}));
    var actualSize=Number(head.ContentLength||0);
    if(actualSize!==Number(u.size_bytes)){
      return res.status(400).json({error:"Uploaded size mismatch. Resume the upload and complete it again."});
    }
    var fileId=uid();
    var ins=await pool.query(
      "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes,relative_path,content_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING RETURNING *",
      [fileId,u.project_id,u.original_name,path.basename(u.storage_key),u.storage_key,u.mime_type,actualSize,u.relative_path,u.content_fingerprint||null]
    );
    var fileRow=ins.rows[0];
    if(!fileRow)fileRow=(await pool.query("SELECT * FROM files WHERE storage_path=$1",[u.storage_key])).rows[0];
    await pool.query("UPDATE upload_sessions SET status='completed',updated_at=now() WHERE id=$1",[u.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[u.project_id]);
    res.json({ok:true,file:fileRow});
  }catch(e){console.error(e);res.status(500).json({error:"Could not complete upload. The upload can be resumed."})}
});

app.post("/api/uploads/:id/abort",admin,async(req,res)=>{
  try{
    var q=await pool.query("SELECT * FROM upload_sessions WHERE id=$1",[req.params.id]);
    if(!q.rowCount)return res.status(404).json({error:"Upload session not found."});
    var u=q.rows[0];
    if(u.mode==="multipart"&&u.multipart_upload_id){
      await s3.send(new AbortMultipartUploadCommand({Bucket:bucket(),Key:u.storage_key,UploadId:u.multipart_upload_id})).catch(function(){});
    }else if(s3Ready()){
      await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:u.storage_key})).catch(function(){});
    }
    await pool.query("UPDATE upload_sessions SET status='aborted',updated_at=now() WHERE id=$1",[u.id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not cancel upload."})}
});

app.post("/api/projects/:id/files",admin,(req,res)=>{
 if(!s3Ready())return res.status(503).json({error:"Cloud file storage is not ready yet. Try again in a moment."});
 const projectId=req.params.id;
 const bb=Busboy({headers:req.headers,limits:{files:100,fileSize:MAX_FILE_SIZE}});
 const jobs=[];const staged=[];let uploadError=null;

 bb.on("field",()=>{});
 bb.on("file",(field,file,info)=>{
   if(field!=="files"){file.resume();return}
   const id=uid();
   const originalName=String(info.filename||"file");
   const storagePath=`projects/${projectId}/${id}/${safeName(originalName)}`;
   let tooLarge=false;
   file.on("limit",()=>{tooLarge=true;uploadError=new Error("A file exceeded the 10 GB limit.")});
   const uploader=new Upload({
     client:s3,
     params:{Bucket:bucket(),Key:storagePath,Body:file,ContentType:info.mimeType||"application/octet-stream"}
   });
   const job=uploader.done().then(async()=>{
     if(tooLarge)throw new Error("A file exceeded the 10 GB limit.");
     const head=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:storagePath}));
     const size=Number(head.ContentLength||0);
     const r=await pool.query("INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[id,projectId,originalName,path.basename(storagePath),storagePath,info.mimeType||"application/octet-stream",size]);
     staged.push({id,storagePath});
     return r.rows[0];
   }).catch(e=>{uploadError=e;throw e});
   jobs.push(job);
 });
 bb.on("finish",async()=>{
   try{
     const project=await pool.query("SELECT id FROM projects WHERE id=$1",[projectId]);if(!project.rowCount)throw new Error("Project not found");
     const results=await Promise.all(jobs);
     await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
     res.json({files:results});
   }catch(e){
     console.error(e);
     for(const x of staged)await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:x.storagePath})).catch(()=>{});
     res.status(400).json({error:uploadError?.message||e.message||"Upload failed"});
   }
 });
 bb.on("error",e=>{console.error(e);if(!res.headersSent)res.status(400).json({error:e.message||"Upload failed"})});
 req.pipe(bb);
});

app.delete("/api/files/:id",admin,async(req,res)=>{
 try{
  const r=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);if(!r.rowCount)return res.status(404).json({error:"File not found"});
  const f=r.rows[0];if(s3Ready())await s3.send(new DeleteObjectCommand({Bucket:bucket(),Key:f.storage_path}));
  await pool.query("DELETE FROM files WHERE id=$1",[f.id]);await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[f.project_id]);
  res.json({ok:true});
 }catch(e){console.error(e);res.status(500).json({error:"Could not delete file"})}
});

async function signedFileUrl(fileId,tokenValue=null){
 const q=await pool.query("SELECT f.*,p.shared,p.share_token,p.expires_at FROM files f JOIN projects p ON p.id=f.project_id WHERE f.id=$1",[fileId]);if(!q.rowCount)return null;
 const f=q.rows[0];
 if(tokenValue!==null){
   if(f.share_token!==tokenValue||!f.shared||(f.expires_at&&new Date(f.expires_at).getTime()<Date.now()))return null;
 } 
 if(!s3Ready())throw new Error("Cloud file storage is not ready");
 const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:f.storage_path}),{expiresIn:900});
 return {f,url};
}

app.get("/api/admin/file/:id",admin,async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id);if(!out)return res.status(404).send("File not found");
  res.redirect(out.url);
 }catch(e){console.error(e);res.status(500).send("Unable to serve file")}
});

app.get("/api/admin/thumb/:id",admin,async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,original_name,storage_path,mime_type FROM files WHERE id=$1",[req.params.id]);
  if(!q.rowCount)return res.status(404).send("File not found");
  const f=q.rows[0];
  const width=Math.max(160,Math.min(640,Number(req.query.w||360))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(f);
  const cacheKey="admin:"+f.id+":"+kind+":"+width+"x"+height,cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(cached.buffer);
  const thumbKey="__admin-thumbnails/"+crypto.createHash("sha1").update(String(f.id)+"|"+kind+"|"+width+"|"+height).digest("hex")+".webp";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:thumbKey}));
    if(head.ContentLength){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:thumbKey}));
      const bytes=got.Body?.transformToByteArray?Buffer.from(await got.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
      setThumbCache(cacheKey,bytes);
      return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(bytes);
    }
  }catch(_e){}
  const webp=await generateThumbnail(f,width,height);
  setThumbCache(cacheKey,webp);
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:thumbKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(f.id),generated_by:"fbi-client-file-studio-admin-media-aware"}}));
  }catch(err){console.warn("Could not persist admin thumbnail",err?.message||err)}
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(webp);
 }catch(e){console.error("Admin thumbnail generation failed",e?.stack||e);res.status(500).send("Unable to generate thumbnail");}
});
app.get("/api/public/share/:token",async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,name,client_name,note,expires_at FROM projects WHERE share_token=$1 AND shared=true",[req.params.token]);
  if(!q.rowCount)return res.status(404).json({error:"This delivery link is invalid, disabled, or expired."});
  const p=q.rows[0];if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).json({error:"This delivery link has expired."});
  const f=await pool.query("SELECT id,original_name,relative_path,mime_type,size_bytes,created_at FROM files WHERE project_id=$1 ORDER BY relative_path ASC,created_at DESC",[p.id]);
  const base=PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`;
  const settings=await loadSettings();
  res.set("Cache-Control","private, max-age=20, stale-while-revalidate=60");
  res.json({project:p,settings:{portal_title:settings.portal_title,allow_client_preview:settingBool(settings.allow_client_preview),show_file_size:settingBool(settings.show_file_size)},files:f.rows.map(x=>({...x,download_url:`${base}/api/public/file/${x.id}?token=${encodeURIComponent(req.params.token)}`}))});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load delivery"})}
});

app.get("/api/public/thumb/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));
  if(!out)return res.status(404).send("Invalid or expired delivery link.");
  const width=Math.max(240,Math.min(720,Number(req.query.w||420))),height=Math.max(160,Math.min(720,Number(req.query.h||540)));
  const kind=thumbKind(out.f);
  const cacheKey=out.f.id+":"+kind+":"+width+"x"+height+":natural";
  const cached=getThumbCache(cacheKey);
  if(cached)return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(cached.buffer);
  const thumbKey="__thumbnails/"+crypto.createHash("sha1").update(String(out.f.id)+"|"+kind+"|"+width+"|"+height+"|natural").digest("hex")+".webp";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:thumbKey}));
    if(head.ContentLength){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:thumbKey}));
      const bytes=got.Body?.transformToByteArray?Buffer.from(await got.Body.transformToByteArray()):Buffer.from(await new Promise((resolve,reject)=>{const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject)}));
      setThumbCache(cacheKey,bytes);
      return res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(bytes);
    }
  }catch(_e){}
  const webp=await generateThumbnail(out.f,width,height);
  setThumbCache(cacheKey,webp);
  try{
    await s3.send(new PutObjectCommand({Bucket:bucket(),Key:thumbKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(out.f.id),generated_by:"fbi-client-file-studio-media-aware"}}));
  }catch(err){console.warn("Could not persist public thumbnail",err?.message||err)}
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=31536000, immutable").set("X-Content-Type-Options","nosniff").send(webp);
 }catch(e){console.error("Thumbnail generation failed",e?.stack||e);res.status(500).send("Unable to generate thumbnail");}
});
app.get("/api/public/preview/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));
  if(!out)return res.status(404).send("Invalid or expired delivery link.");
  if(!/^image\//i.test(out.f.mime_type||""))return res.status(415).send("Image preview only.");
  const width=Math.max(600,Math.min(1800,Number(req.query.w||1400)));
  const height=Math.max(400,Math.min(1200,Number(req.query.h||1000)));
  const cacheKey=out.f.id+":preview:"+width+"x"+height;
  const cached=getThumbCache(cacheKey);
  if(cached){
    return res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(cached.buffer);
  }
  const previewKey="__previews/"+crypto.createHash("sha1").update(String(out.f.id)+"|"+width+"|"+height).digest("hex")+".webp";
  try{
    const head=await s3.send(new HeadObjectCommand({Bucket:bucket(),Key:previewKey}));
    if(head.ContentLength){
      const got=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:previewKey}));
      const bytes=got.Body?.transformToByteArray ? Buffer.from(await got.Body.transformToByteArray()) : Buffer.from(await new Promise((resolve,reject)=>{
        const chunks=[];got.Body.on("data",c=>chunks.push(c));got.Body.on("end",()=>resolve(Buffer.concat(chunks)));got.Body.on("error",reject);
      }));
      setThumbCache(cacheKey,bytes);
      return res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(bytes);
    }
  }catch(_e){}
  const obj=await s3.send(new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}));
  const input=obj.Body?.transformToByteArray ? Buffer.from(await obj.Body.transformToByteArray()) : Buffer.from(await new Promise((resolve,reject)=>{
    const chunks=[];obj.Body.on("data",c=>chunks.push(c));obj.Body.on("end",()=>resolve(Buffer.concat(chunks)));obj.Body.on("error",reject);
  }));
  const webp=await sharp(input).rotate().resize({width,height,fit:"inside",withoutEnlargement:true}).webp({quality:82,method:4}).toBuffer();
  setThumbCache(cacheKey,webp);
  try{await s3.send(new PutObjectCommand({Bucket:bucket(),Key:previewKey,Body:webp,ContentType:"image/webp",CacheControl:"private, max-age=31536000, immutable",Metadata:{source_file_id:String(out.f.id),generated_by:"fbi-client-file-studio"}}))}catch(err){console.warn("Could not persist preview",err?.message||err)}
  res.status(200).type("image/webp").set("Cache-Control","private, max-age=3600, stale-while-revalidate=86400").send(webp);
 }catch(e){
  console.error("Image preview generation failed",e?.stack||e);
  res.status(500).send("Unable to generate preview");
 }
});

app.get("/api/public/file/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));if(!out)return res.status(404).send("Invalid or expired delivery link.");
  const settings=await loadSettings();
  if(settingBool(settings.log_downloads)){
    await pool.query("INSERT INTO downloads(project_id,file_id,user_agent,ip_address) VALUES($1,$2,$3,$4)",[out.f.project_id,out.f.id,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req)]);
  }
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}),{expiresIn:900,responseContentDisposition:req.query.download==="1"?`attachment; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`:`inline; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`});
  res.redirect(url);
 }catch(e){console.error(e);res.status(500).send("Unable to serve file")}
});

app.get("/share/:token/manifest.webmanifest",async(req,res)=>{
  try{
    const tokenValue=String(req.params.token||"");
    const q=await pool.query("SELECT id,name,expires_at FROM projects WHERE share_token=$1 AND shared=true",[tokenValue]);
    if(!q.rowCount)return res.status(404).type("text/plain").send("Delivery not found");
    const p=q.rows[0];
    if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).type("text/plain").send("Delivery expired");
    const short=String(p.name||"FBI Client Delivery").trim().slice(0,24)||"FBI Client Delivery";
    const manifest={
      name:"FBI Client Delivery",
      short_name:short,
      start_url:"/share/"+encodeURIComponent(tokenValue),
      scope:"/share/",
      display:"standalone",
      orientation:"any",
      background_color:"#09090a",
      theme_color:"#0a0a0b",
      description:"Secure client delivery from Film Beyond Imagination.",
      icons:[
        {src:"/pwa-icon.svg",sizes:"any",type:"image/svg+xml",purpose:"any maskable"}
      ]
    };
    res.type("application/manifest+json").send(JSON.stringify(manifest));
  }catch(e){
    console.error(e);
    res.status(500).type("text/plain").send("Unable to build delivery manifest");
  }
});

app.get("/manifest.webmanifest",(req,res)=>{
  res.type("application/manifest+json").sendFile(path.join(ROOT,"manifest.webmanifest"));
});
app.get("/pwa-icon.svg",(req,res)=>{
  res.type("image/svg+xml").sendFile(path.join(ROOT,"pwa-icon.svg"));
});
app.get("/sw.js",(req,res)=>{
  res.type("application/javascript").set("Cache-Control","no-cache").sendFile(path.join(ROOT,"sw.js"));
});
app.post("/portal",async(req,res)=>{
 try{
  const mode=String(req.body.auth_mode||"signup");
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  const page=(title,message,href,text)=>res.status(400).type("html").send("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>"+title+"</title><body style=\"font-family:system-ui;padding:40px;background:#09090a;color:#fff\"><h2>"+title+"</h2><p>"+message+"</p><p><a href=\""+href+"\" style=\"color:#f4d56d\">"+text+"</a></p></body>");
  if(mode==="login"){
   const r=await pool.query("SELECT id,email,full_name,password_hash FROM users WHERE email=$1",[email]);
   if(!r.rowCount||!(await userPasswordMatches(password,r.rows[0].password_hash)))return page("Sign in failed","Invalid email or password.","/portal?mode=login","Back to sign in");
   const u={id:r.rows[0].id,email:r.rows[0].email,full_name:r.rows[0].full_name};
   res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(u))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
   return res.redirect(303,"/portal");
  }
  const fullName=String(req.body.full_name||"").trim().slice(0,120);
  if(!fullName)return page("Account creation failed","Full name is required.","/portal","Back to account creation");
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return page("Account creation failed","Enter a valid email address.","/portal","Back to account creation");
  if(password.length<10)return page("Account creation failed","Password must be at least 10 characters.","/portal","Back to account creation");
  const existing=await pool.query("SELECT id FROM users WHERE email=$1",[email]);
  if(existing.rowCount)return page("Account already exists","Use the sign-in option for this email.","/portal?mode=login","Sign in");
  const id=uid(),hash=await hashUserPassword(password);
  const r=await pool.query("INSERT INTO users(id,email,full_name,password_hash) VALUES($1,$2,$3,$4) RETURNING id,email,full_name",[id,email,fullName,hash]);
  res.setHeader("Set-Cookie","fbi_user_session="+encodeURIComponent(userSession(r.rows[0]))+"; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000");
  return res.redirect(303,"/portal");
 }catch(e){console.error("Portal form fallback failed:",e);return res.status(500).type("html").send("<!doctype html><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Portal error</title><body style=\"font-family:system-ui;padding:40px;background:#09090a;color:#fff\"><h2>Portal error</h2><p>Please try again.</p><p><a href=\"/portal\" style=\"color:#f4d56d\">Back to portal</a></p></body>")}
});
app.get("/portal.html",(req,res)=>{res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.type("html").sendFile(path.join(ROOT,"portal.html"))});
app.get("/portal",(req,res)=>{res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");res.type("html").sendFile(path.join(ROOT,"portal.html"))});
app.get("/editor.html",(req,res)=>{
  if(!validSession(req))return res.redirect("/");
  res.set("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma","no-cache");
  res.set("Expires","0");
  res.type("html").sendFile(path.join(ROOT,"editor.html"));
});

app.use((req,res)=>res.sendFile(path.join(ROOT,"index.html")));

initDb().then(async()=>{await ensureBucketCors();app.listen(PORT,"0.0.0.0",()=>console.log("FBI Client File Studio listening on port "+PORT))}).catch(e=>{console.error(e);process.exit(1)});
