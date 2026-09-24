const express=require("express");
const multer=require("multer");
const {Pool}=require("pg");
const crypto=require("crypto");
const fs=require("fs");
const fsp=fs.promises;
const path=require("path");

const app=express();
const PORT=Number(process.env.PORT||3000);
const ROOT=path.join(__dirname,"site");
const FILES_ROOT=path.resolve(process.env.FILES_ROOT||"/data/files");
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||"filmbyfbi@gmail.com").trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.randomBytes(32).toString("hex");
const PUBLIC_BASE_URL=(process.env.PUBLIC_BASE_URL||"").replace(/\/+$/,"");

if(!ADMIN_PASSWORD){
  console.warn("ADMIN_PASSWORD is not set. Set it in Railway Variables before using production login.");
}

const pool=new Pool({
  connectionString:process.env.DATABASE_URL,
  ssl:process.env.DATABASE_URL ? {rejectUnauthorized:false}:false
});

const MIME_DEFAULT="application/octet-stream";

function uid(){return crypto.randomUUID();}
function token(){return crypto.randomBytes(24).toString("base64url");}
function safeName(name){
  const ext=path.extname(name);
  const base=path.basename(name,ext)
    .replace(/[^a-zA-Z0-9._-]+/g,"_")
    .replace(/^\.+/,"")
    .slice(0,140)||"file";
  return base+ext;
}
function parseCookies(req){
  const out={};
  const raw=req.headers.cookie||"";
  raw.split(";").forEach(part=>{
    const i=part.indexOf("=");
    if(i>0) out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  });
  return out;
}
function signSession(email){
  const exp=Date.now()+1000*60*60*24*7;
  const payload=Buffer.from(JSON.stringify({email,exp})).toString("base64url");
  const sig=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  return payload+"."+sig;
}
function validSession(req){
  const s=parseCookies(req).fbi_session;
  if(!s) return false;
  const [payload,sig]=s.split(".");
  if(!payload||!sig) return false;
  const expected=crypto.createHmac("sha256",SESSION_SECRET).update(payload).digest("base64url");
  if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) return false;
  try{
    const data=JSON.parse(Buffer.from(payload,"base64url").toString("utf8"));
    return data.email===ADMIN_EMAIL && Number(data.exp)>Date.now();
  }catch{return false;}
}
function requireAdmin(req,res,next){
  if(!validSession(req)) return res.status(401).json({error:"Unauthorised"});
  next();
}
function clientIp(req){
  const f=req.headers["x-forwarded-for"];
  return (Array.isArray(f)?f[0]:String(f||req.socket.remoteAddress||"")).split(",")[0].trim().slice(0,120);
}

async function initDb(){
  await fsp.mkdir(FILES_ROOT,{recursive:true});
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

const storage=multer.diskStorage({
  destination:async(req,file,cb)=>{
    const projectId=req.params.id;
    const dir=path.join(FILES_ROOT,projectId);
    try{await fsp.mkdir(dir,{recursive:true});cb(null,dir);}catch(e){cb(e);}
  },
  filename:(req,file,cb)=>{
    cb(null,uid()+"-"+safeName(file.originalname));
  }
});
const upload=multer({
  storage,
  limits:{fileSize:10*1024*1024*1024,files:100}
});

app.use(express.json({limit:"2mb"}));
app.use(express.urlencoded({extended:true}));

app.get("/health",(req,res)=>res.json({ok:true,service:"FBI Client File Studio",time:new Date().toISOString()}));

app.post("/api/auth/login",(req,res)=>{
  const email=String(req.body.email||"").trim().toLowerCase();
  const password=String(req.body.password||"");
  if(email!==ADMIN_EMAIL || !ADMIN_PASSWORD || password!==ADMIN_PASSWORD){
    return res.status(401).json({error:"Invalid email or password"});
  }
  res.setHeader("Set-Cookie",`fbi_session=${encodeURIComponent(signSession(email))}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`);
  res.json({ok:true,email});
});
app.post("/api/auth/logout",(req,res)=>{
  res.setHeader("Set-Cookie","fbi_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
  res.json({ok:true});
});
app.get("/api/auth/me",(req,res)=>{
  res.json(validSession(req)?{authenticated:true,email:ADMIN_EMAIL}:{authenticated:false});
});

app.get("/api/projects",requireAdmin,async(req,res)=>{
  try{
    const q=String(req.query.q||"").trim();
    const result=await pool.query(`
      SELECT p.*,
        (SELECT count(*) FROM files f WHERE f.project_id=p.id) AS file_count,
        COALESCE((SELECT sum(size_bytes) FROM files f WHERE f.project_id=p.id),0) AS total_bytes
      FROM projects p
      ${q?"WHERE p.name ILIKE $1 OR p.client_name ILIKE $1 OR p.client_email ILIKE $1":""}
      ORDER BY p.updated_at DESC
    `,q?[`%${q}%`]:[]);
    res.json({projects:result.rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load projects"});}
});

app.post("/api/projects",requireAdmin,async(req,res)=>{
  try{
    const name=String(req.body.name||"").trim();
    if(!name) return res.status(400).json({error:"Project name is required"});
    const id=uid();
    const shareToken=token();
    const r=await pool.query(
      "INSERT INTO projects(id,name,client_name,client_email,note,share_token) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",
      [id,name,String(req.body.client_name||"").trim(),String(req.body.client_email||"").trim(),String(req.body.note||"").trim(),shareToken]
    );
    res.json({project:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create project"});}
});

app.get("/api/projects/:id",requireAdmin,async(req,res)=>{
  try{
    const p=await pool.query("SELECT * FROM projects WHERE id=$1",[req.params.id]);
    if(!p.rowCount) return res.status(404).json({error:"Project not found"});
    const f=await pool.query("SELECT * FROM files WHERE project_id=$1 ORDER BY created_at DESC",[req.params.id]);
    res.json({project:p.rows[0],files:f.rows});
  }catch(e){console.error(e);res.status(500).json({error:"Could not load project"});}
});

app.patch("/api/projects/:id",requireAdmin,async(req,res)=>{
  try{
    const allowed=["name","client_name","client_email","note","expires_at","shared"];
    const fields=[];const values=[];let n=1;
    for(const key of allowed){
      if(Object.prototype.hasOwnProperty.call(req.body,key)){
        fields.push(`${key}=$${n++}`);
        values.push(key==="shared"?Boolean(req.body[key]):(req.body[key]===null?"":String(req.body[key]).trim()));
      }
    }
    if(!fields.length) return res.status(400).json({error:"Nothing to update"});
    fields.push("updated_at=now()");
    values.push(req.params.id);
    const r=await pool.query(`UPDATE projects SET ${fields.join(",")} WHERE id=$${n} RETURNING *`,values);
    if(!r.rowCount) return res.status(404).json({error:"Project not found"});
    res.json({project:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not update project"});}
});

app.post("/api/projects/:id/regenerate-link",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query("UPDATE projects SET share_token=$1,shared=true,updated_at=now() WHERE id=$2 RETURNING *",[token(),req.params.id]);
    if(!r.rowCount) return res.status(404).json({error:"Project not found"});
    res.json({project:r.rows[0]});
  }catch(e){console.error(e);res.status(500).json({error:"Could not create share link"});}
});

app.post("/api/projects/:id/files",requireAdmin,upload.array("files",100),async(req,res)=>{
  const projectId=req.params.id;
  try{
    const p=await pool.query("SELECT id FROM projects WHERE id=$1",[projectId]);
    if(!p.rowCount){
      for(const f of (req.files||[])) await fsp.rm(f.path,{force:true}).catch(()=>{});
      return res.status(404).json({error:"Project not found"});
    }
    const saved=[];
    for(const f of (req.files||[])){
      const id=uid();
      const rel=path.relative(FILES_ROOT,f.path);
      const r=await pool.query(
        "INSERT INTO files(id,project_id,original_name,storage_name,storage_path,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",
        [id,projectId,f.originalname,f.filename,rel,f.mimetype||MIME_DEFAULT,f.size||0]
      );
      saved.push(r.rows[0]);
    }
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[projectId]);
    res.json({files:saved});
  }catch(e){
    console.error(e);
    for(const f of (req.files||[])) await fsp.rm(f.path,{force:true}).catch(()=>{});
    res.status(500).json({error:"Upload failed"});
  }
});

app.delete("/api/files/:id",requireAdmin,async(req,res)=>{
  try{
    const r=await pool.query("SELECT * FROM files WHERE id=$1",[req.params.id]);
    if(!r.rowCount) return res.status(404).json({error:"File not found"});
    const f=r.rows[0];
    await fsp.rm(path.join(FILES_ROOT,f.storage_path),{force:true});
    await pool.query("DELETE FROM files WHERE id=$1",[f.id]);
    await pool.query("UPDATE projects SET updated_at=now() WHERE id=$1",[f.project_id]);
    res.json({ok:true});
  }catch(e){console.error(e);res.status(500).json({error:"Could not delete file"});}
});

app.get("/api/projects/:id/download-all",requireAdmin,async(req,res)=>{
  res.status(400).json({error:"Download all is handled from the project UI so files remain individually named."});
});

async function getPublicProject(tokenValue){
  const r=await pool.query("SELECT * FROM projects WHERE share_token=$1 AND shared=true",[tokenValue]);
  if(!r.rowCount) return null;
  const p=r.rows[0];
  if(p.expires_at && new Date(p.expires_at).getTime()<Date.now()) return null;
  const f=await pool.query("SELECT id,original_name,mime_type,size_bytes,created_at FROM files WHERE project_id=$1 ORDER BY created_at DESC",[p.id]);
  return {project:p,files:f.rows};
}

app.get("/api/public/share/:token",async(req,res)=>{
  try{
    const data=await getPublicProject(req.params.token);
    if(!data) return res.status(404).json({error:"This delivery link is invalid, disabled, or expired."});
    const base=PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`;
    res.json({
      project:{
        name:data.project.name,
        client_name:data.project.client_name,
        note:data.project.note,
        expires_at:data.project.expires_at
      },
      files:data.files.map(f=>({
        ...f,
        download_url:`${base}/api/public/file/${f.id}?token=${encodeURIComponent(req.params.token)}`
      }))
    });
  }catch(e){console.error(e);res.status(500).json({error:"Could not load delivery"});}
});

app.get("/api/public/file/:id",async(req,res)=>{
  try{
    const tokenValue=String(req.query.token||"");
    const data=await getPublicProject(tokenValue);
    if(!data) return res.status(404).send("Invalid or expired delivery link.");
    const f=data.files.find(x=>x.id===req.params.id);
    if(!f) return res.status(404).send("File not found.");
    const full=await pool.query("SELECT * FROM files WHERE id=$1",[f.id]);
    if(!full.rowCount) return res.status(404).send("File not found.");
    const row=full.rows[0];
    const absolute=path.join(FILES_ROOT,row.storage_path);
    if(!absolute.startsWith(FILES_ROOT+path.sep) && absolute!==FILES_ROOT) return res.status(400).send("Invalid path.");
    try{await fsp.access(absolute);}catch{return res.status(404).send("File is no longer available.");}
    const isDownload=String(req.query.download||"") === "1";
    await pool.query(
      "INSERT INTO downloads(project_id,file_id,user_agent,ip_address) VALUES($1,$2,$3,$4)",
      [row.project_id,row.id,String(req.headers["user-agent"]||"").slice(0,1000),clientIp(req)]
    );
    if(isDownload){
      return res.download(absolute,row.original_name,{dotfiles:"deny"},()=>{});
    }
    res.setHeader("Content-Type",row.mime_type||MIME_DEFAULT);
    res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
    res.sendFile(absolute);
  }catch(e){console.error(e);res.status(500).send("Unable to serve file.");}
});

app.use((req,res)=>{
  res.sendFile(path.join(ROOT,"index.html"));
});

initDb().then(()=>{
  app.listen(PORT,"0.0.0.0",()=>console.log(`FBI Client File Studio listening on port ${PORT}`));
}).catch(e=>{
  console.error("Database initialisation failed:",e);
  process.exit(1);
});
