const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("site/portal.html", "utf8");
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
let checked = 0;

for (let i = 0; i < scripts.length; i += 1) {
  const attrs = scripts[i][1] || "";
  const code = scripts[i][2] || "";
  if (!code.trim() || /type\s*=\s*["']application\/(?:json|ld\+json)["']/i.test(attrs)) continue;
  new vm.Script(code, { filename: "site/portal.html:inline-script-" + (i + 1) });
  checked += 1;
}

if (!checked) {
  console.error("No inline JavaScript blocks were found in site/portal.html.");
  process.exit(1);
}
console.log("Validated " + checked + " inline JavaScript block(s) in site/portal.html.");
