// Runs the gateway on your own machine with Node, using the exact handler
// that Cloudflare runs. With STORAGE_BACKEND=local (the default here) files
// land in ./sandbox; set STORAGE_BACKEND=dropbox plus the Dropbox values in
// .dev.vars to exercise real Dropbox before deploying anything.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LocalAdapter } from "@folderstore/adapter-local";
import { randomId } from "@folderstore/core";
import { buildBackend, createGateway, loadConfig, type Backend, type Env } from "@folderstore/gateway";

function readDevVars(path: string): Env {
  if (!existsSync(path)) return {};
  const env: Env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return env;
}

const port = Number(process.env.PORT ?? 8787);
const env: Env = { STORAGE_BACKEND: "local", ...readDevVars(resolve(".dev.vars")), ...process.env };
let generated = false;
if (!env.SIGNING_KEY) {
  env.SIGNING_KEY = randomId(32);
  generated = true;
}
if (!env.ADMIN_SECRET) {
  env.ADMIN_SECRET = randomId(18);
  generated = true;
}

const config = loadConfig(env);
const localRoot = resolve(env.LOCAL_ROOT ?? "sandbox");
const backend: Backend =
  config.backend === "local" ? { adapter: new LocalAdapter(localRoot), connect: null } : buildBackend(env);
const handle = createGateway({ config, backend });

async function toRequest(req: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const method = req.method ?? "GET";
  return new Request(`http://localhost:${port}${req.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
  });
}

async function send(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}

createServer(async (req, res) => {
  try {
    await send(res, await handle(await toRequest(req)));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end("Internal error");
  }
}).listen(port, () => {
  console.log(`FolderStore gateway (dev) on http://localhost:${port}`);
  console.log(`  backend: ${config.backend}${config.backend === "local" ? ` (${localRoot})` : ""}`);
  if (generated) {
    console.log(`  ADMIN_SECRET (generated for this run): ${env.ADMIN_SECRET}`);
    console.log("  Links stop working when you restart unless SIGNING_KEY is set in .dev.vars.");
  }
  console.log(`  Setup page: http://localhost:${port}/`);
});
