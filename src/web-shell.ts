import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const files = new Map<string, URL>([
  ["/", new URL("./web/index.html", import.meta.url)],
  ...[
    "pair.ts",
    "push.ts",
    "index.html",
    "app.css",
    "api.ts",
    "render.ts",
    "main.ts",
    "manifest.webmanifest",
    "sw.js",
    "icons/icon.svg",
    "icons/icon-192.png",
    "icons/icon-512.png",
    "icons/badge-96.png",
  ].map((name) => [`/web/${name}`, new URL(`./web/${name}`, import.meta.url)] as [string, URL]),
  ...["status.ts", "agent-name.ts", "model-selection.ts"].map(
    (name) => [`/${name}`, new URL(`./${name}`, import.meta.url)] as [string, URL],
  ),
  ["/web/marked.js", new URL(import.meta.resolve("marked"))],
]);
export const shellPath = (path: string) => files.has(path);
// Read from disk on every request (the files are small), so a page refresh shows edits
// without a host restart. Only the import map's CSP hash below is fixed at startup.
export async function shellFile(path: string) {
  const file = files.get(path);
  if (!file) return;
  let body: string | Buffer = await readFile(file);
  if (path.endsWith(".ts")) body = stripTypeScriptTypes(body.toString(), { mode: "strip" });
  const extension = file.pathname.split(".").pop()!;
  const type = (
    {
      ts: "text/javascript",
      js: "text/javascript",
      html: "text/html",
      css: "text/css",
      webmanifest: "application/manifest+json",
      svg: "image/svg+xml",
      png: "image/png",
    } as Record<string, string>
  )[extension];
  return { body, type };
}

// The sole inline script is the declarative import map required by native modules.
const html = await readFile(new URL("./web/index.html", import.meta.url), "utf8");
const importMap = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]!;
const mapHash = createHash("sha256").update(importMap).digest("base64");
export const shellCsp =
  "default-src 'self'; img-src 'self' data:; style-src 'self'; " +
  `script-src 'self' 'sha256-${mapHash}'; frame-ancestors 'none'; base-uri 'none'`;
