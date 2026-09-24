const express=require("express");
const Busboy=require("busboy");
const {Pool}=require("pg");
const crypto=require("crypto");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");
const {S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand}=require("@aws-sdk/client-s3");
const {Upload}=require("@aws-sdk/lib-storage");
const {getSignedUrl}=require("@aws-sdk/s3-request-presigner");

const app=express();
const PORT=Number(process.env.PORT||3000);
const ROOT=path.join(__dirname,"site");
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").replace(/\/+$/,"");
const MAX_FILE_SIZE=10*1024*1024*1024;

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
function clientIp(req){return String(req.headers["x-forwarded-for"]||req.socket.remoteAddress||"").split(",")[0].trim().slice(0,120)}
function s3Ready(){return Boolean(process.env.S3_BUCKET&&process.env.S3_ENDPOINT&&process.env.S3_ACCESS_KEY_ID&&process.env.S3_SECRET_ACCESS_KEY&&process.env.S3_REGION)}
const s3=s3Ready()?new S3Client({
  region:process.env.S3_REGION,
  endpoint:process.env.S3_ENDPOINT,
  forcePathStyle:true,
  credentials:{accessKeyId:process.env.S3_ACCESS_KEY_ID,secretAccessKey:process.env.S3_SECRET_ACCESS_KEY}
}):null;
const bucket=()=>process.env.S3_BUCKET;

async function initDb(){
  if(!process.env.DATABASE_URL)throw new Error("DATABASE_URL is missing");
  if(!s3Ready())console.warn("Railway bucket variables are not ready yet.");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS projects(
      id uuid PRIMARY KEY,
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
  `);
}

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

app.get("/health",(req,res)=>res.json({ok:true,service:"FBI Client File Studio",storage:s3Ready()?"railway-object-storage":"not-ready",time:new Date().toISOString()}));

app.post("/api/auth/login",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(email!==ADMIN_EMAIL||!ADMIN_PASSWORD||password!==ADMIN_PASSWORD)return res.status(401).json({error:"Invalid email or password"});
  res.setHeader("Set-Cookie",`fbi_session=${encodeURIComponent(session(email))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
  res.json({ok:true,email});
});
app.post("/api/auth/logout",(req,res)=>{
  res.setHeader("Set-Cookie","fbi_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/auth/me",(req,res)=>res.json(validSession(req)?{authenticated:true,email:ADMIN_EMAIL}:{authenticated:false}));

app.get("/api/projects",admin,async(req,res)=>{
 try{
  const q=String(req.query.q||"").trim();
  const r=await pool.query(`SELECT p.*,(SELECT count(*) FROM files f WHERE f.project_id=p.id) file_count,COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) total_bytes FROM projects p ${q?"WHERE p.name ILIKE $1 OR p.client_name ILIKE $1 OR p.client_email ILIKE $1":""} ORDER BY p.updated_at DESC`,q?[`%${q}%`]:[]);
  res.json({projects:r.rows});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load projects"})}
});

app.post("/api/projects",admin,async(req,res)=>{
 try{
  const name=String(req.body.name||"").trim();if(!name)return res.status(400).json({error:"Project name is required"});
  const id=uid(),shareToken=token();
  const r=await pool.query("INSERT INTO projects(id,name,client_name,client_email,note,share_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),String(req.body.note||"").trim(),shareToken]);
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
  const allowed=["name","client_name","client_email","note","expires_at","shared"];const fields=[],values=[];let n=1;
  for(const k of allowed)if(Object.prototype.hasOwnProperty.call(req.body,k)){fields.push(`${k}=$${n++}`);values.push(k==="shared"?Boolean(req.body[k]):req.body[k]===null?null:String(req.body[k]).trim())}
  if(!fields.length)return res.status(400).json({error:"Nothing to update"});
  fields.push("updated_at=now()");values.push(req.params.id);
  const r=await pool.query(`UPDATE projects SET ${fields.join(",")} WHERE id=$${n} RETURNING *`,values);if(!r.rowCount)return res.status(404).json({error:"Project not found"});
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not update project"})}
});
app.post("/api/projects/:id/regenerate-link",admin,async(req,res)=>{
 try{
  const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 RETURNING *",[token(),req.params.id]);if(!r.rowCount)return res.status(404).json({error:"Project not found"});
  res.json({project:r.rows[0]});
 }catch(e){console.error(e);res.status(500).json({error:"Could not create share link"})}
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

app.get("/api/public/share/:token",async(req,res)=>{
 try{
  const q=await pool.query("SELECT id,name,client_name,note,expires_at FROM projects WHERE share_token=$1 AND shared=true",[req.params.token]);
  if(!q.rowCount)return res.status(404).json({error:"This delivery link is invalid, disabled, or expired."});
  const p=q.rows[0];if(p.expires_at&&new Date(p.expires_at).getTime()<Date.now())return res.status(404).json({error:"This delivery link has expired."});
  const f=await pool.query("SELECT id,original_name,mime_type,size_bytes,created_at FROM files WHERE project_id=$1 ORDER BY created_at DESC",[p.id]);
  const base=PUBLIC_BASE_URL||`${req.protocol}://${req.get("host")}`;
  res.json({project:p,files:f.rows.map(x=>({...x,download_url:`${base}/api/public/file/${x.id}?token=${encodeURIComponent(req.params.token)}`}))});
 }catch(e){console.error(e);res.status(500).json({error:"Could not load delivery"})}
});

app.get("/api/public/file/:id",async(req,res)=>{
 try{
  const out=await signedFileUrl(req.params.id,String(req.query.token||""));if(!out)return res.status(404).send("Invalid or expired delivery link.");
  await pool.query("INSERT INTO downloads(project_id,file_id,user_agent,ip_address) VALUES($1,$2,$3,$4)",[out.f.project_id,out.f.id,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req)]);
  const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:bucket(),Key:out.f.storage_path}),{expiresIn:900,responseContentDisposition:req.query.download==="1"?`attachment; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`:`inline; filename*=UTF-8''${encodeURIComponent(out.f.original_name)}`});
  res.redirect(url);
 }catch(e){console.error(e);res.status(500).send("Unable to serve file")}
});

app.use((req,res)=>res.sendFile(path.join(ROOT,"index.html")));

initDb().then(()=>app.listen(PORT,"0.0.0.0",()=>console.log(`FBI Client File Studio listening on ${PORT}`))).catch(e=>{console.error(e);process.exit(1)});
