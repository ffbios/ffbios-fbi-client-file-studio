const http = require("http");
const fs = require("fs");
const path = require("path");
const port = process.env.PORT || 3000;
const root = path.join(__dirname, "site");

const mime = {
  ".html":"text/html; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".json":"application/json; charset=utf-8",
  ".png":"image/png",
  ".jpg":"image/jpeg",
  ".jpeg":"image/jpeg",
  ".svg":"image/svg+xml",
  ".ico":"image/x-icon",
  ".webmanifest":"application/manifest+json"
};

function safePath(urlPath){
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const clean = decoded === "/" ? "/index.html" : decoded;
  const target = path.normalize(path.join(root, clean));
  return target.startsWith(root) ? target : path.join(root, "index.html");
}

const server = http.createServer((req,res)=>{
  const target = safePath(req.url);
  fs.stat(target,(err,st)=>{
    if(!err && st.isFile()){
      const ext=path.extname(target).toLowerCase();
      res.writeHead(200,{
        "Content-Type":mime[ext] || "application/octet-stream",
        "Cache-Control":"no-cache"
      });
      fs.createReadStream(target).pipe(res);
      return;
    }
    const fallback=path.join(root,"index.html");
    res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache"});
    fs.createReadStream(fallback).pipe(res);
  });
});

server.listen(port,"0.0.0.0",()=>{
  console.log("FBI Client File Studio listening on port "+port);
});
