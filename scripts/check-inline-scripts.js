const fs = require("node:fs");
const vm = require("node:vm");

const files = [
  "site/portal.html",
  "site/schedule.html",
  "site/library.html",
  "site/airtime.html"
];
let checked = 0;

for (const file of files) {
  const html = fs.readFileSync(file, "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  let pageChecked = 0;
  for (let i = 0; i < scripts.length; i += 1) {
    const attrs = scripts[i][1] || "";
    const code = scripts[i][2] || "";
    if (!code.trim() || /type\s*=\s*["']application\/(?:json|ld\+json)["']/i.test(attrs)) continue;
    new vm.Script(code, { filename: file + ":inline-script-" + (i + 1) });
    checked += 1;
    pageChecked += 1;
  }
  if (!pageChecked) {
    console.error("No inline JavaScript blocks were found in " + file + ".");
    process.exit(1);
  }
}

console.log("Validated " + checked + " inline JavaScript block(s) across the studio pages.");
