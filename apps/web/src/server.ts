import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalAdapter } from "@folderstore/adapter-local";
import { DropboxAdapter } from "@folderstore/adapter-dropbox";
import { GDriveAdapter } from "@folderstore/adapter-gdrive";
import { loadCredentials, writeNoOverwrite, type StorageAdapter } from "@folderstore/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");

interface AdapterConfig {
  type: "local" | "dropbox" | "gdrive";
  root?: string;
  rootFolderId?: string;
}

let adapter: StorageAdapter | null = null;
let adapterLabel = "none";

async function setAdapter(config: AdapterConfig): Promise<void> {
  if (config.type === "local") {
    if (!config.root) throw new Error("root is required for local");
    adapter = new LocalAdapter(config.root);
    adapterLabel = `local:${config.root}`;
  } else if (config.type === "dropbox") {
    const creds = await loadCredentials();
    const token = creds.dropbox?.access_token as string | undefined;
    if (!token) throw new Error("No stored Dropbox token. Run the CLI's auth-dropbox command first.");
    adapter = new DropboxAdapter({ accessToken: token, root: config.root ?? "" });
    adapterLabel = `dropbox:${config.root ?? "/"}`;
  } else if (config.type === "gdrive") {
    if (!config.rootFolderId) throw new Error("rootFolderId is required for gdrive");
    const creds = await loadCredentials();
    const token = creds.gdrive?.access_token as string | undefined;
    if (!token) throw new Error("No stored Google token. Run the CLI's auth-gdrive command first.");
    adapter = new GDriveAdapter({ accessToken: token, rootFolderId: config.rootFolderId });
    adapterLabel = `gdrive:${config.rootFolderId}`;
  } else {
    throw new Error(`Unknown provider: ${(config as { type: string }).type}`);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/") {
      const html = await readFile(join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" }).end(html);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, { adapter: adapterLabel });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/adapter") {
      const body = JSON.parse(await readBody(req)) as AdapterConfig;
      await setAdapter(body);
      sendJson(res, 200, { adapter: adapterLabel });
      return;
    }

    if (!adapter) {
      sendJson(res, 400, { error: "No adapter configured yet. Pick one above first." });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/list") {
      sendJson(res, 200, await adapter.list(url.searchParams.get("path") ?? ""));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/read") {
      const path = url.searchParams.get("path");
      if (!path) throw new Error("path is required");
      const bytes = await adapter.read(path);
      sendJson(res, 200, { path, base64: Buffer.from(bytes).toString("base64") });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/write") {
      const body = JSON.parse(await readBody(req)) as { path: string; contentBase64: string };
      const bytes = Buffer.from(body.contentBase64, "base64");
      const entry = await writeNoOverwrite(adapter, body.path, bytes);
      sendJson(res, 200, entry);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/delete") {
      const body = JSON.parse(await readBody(req)) as { path: string };
      await adapter.delete(body.path);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/changes") {
      sendJson(res, 200, await adapter.changes(url.searchParams.get("cursor")));
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

const PORT = Number(process.env.PORT ?? 4848);
server.listen(PORT, () => {
  console.log(`FolderStore prototype web app: http://localhost:${PORT}`);
});
