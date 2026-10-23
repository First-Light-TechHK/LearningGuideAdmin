import { createServer } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const DIR = "D:/Program/First-Light-TechHK/LearningGuideAdmin/docs/design/figma";
const PORT = 4599;

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".html": "text/html; charset=utf-8" };

createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
  const name = url.replace(/^\//, "");

  if (name === "" || name === "index.html") {
    const files = readdirSync(DIR).filter((f) => /\.(png|jpg)$/i.test(f)).sort();
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>Figma frames</title>
       <body style="font:14px/1.6 Inter,sans-serif;padding:20px">
       ${files.map((f) => `<p><a href="/view/${f}">${f}</a></p>`).join("")}
       </body>`
    );
    return;
  }

  if (name.startsWith("view/")) {
    const file = name.slice(5);
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(
      `<!doctype html><meta charset="utf-8">
       <style>html,body{margin:0;background:#fff}img{display:block;width:100%;height:auto}</style>
       <img src="/${file}" alt="${file}">`
    );
    return;
  }

  const file = join(DIR, name);
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`http://localhost:${PORT}/`));
