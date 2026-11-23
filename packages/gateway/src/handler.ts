// The gateway's single request handler (spec section 6). Platform entry
// files (Cloudflare, Vercel, the Node dev server) only translate their
// request into a web-standard Request and hand it here.

import {
  InvalidPathError,
  NotFoundError,
  PathExistsError,
  ProviderError,
  assertSlug,
  isWithin,
  joinPath,
  normalizePath,
  signLink,
  signState,
  verifyLink,
  verifyState,
  writeNoOverwrite,
  type Entry,
  type LinkClaims,
  type Permission,
  type StorageAdapter,
} from "@folderstore/core";
import type { Backend } from "./backends.js";
import { typeAllowed, type GatewayConfig } from "./config.js";
import { connectResultPage, contributorPage, setupPage } from "./pages.js";

export interface GatewayOptions {
  config: GatewayConfig;
  backend: Backend;
  /** Receives one small record per request. Never given file contents or tokens. */
  log?: (record: Record<string, unknown>) => void;
}

export type Handler = (request: Request) => Promise<Response>;

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const PERMISSIONS: Permission[] = ["upload", "list", "read"];

export function createGateway(opts: GatewayOptions): Handler {
  const { config, backend } = opts;
  const log = opts.log ?? ((record) => console.log(JSON.stringify(record)));

  return async (request) => {
    const url = new URL(request.url);
    const started = Date.now();
    const record: Record<string, unknown> = { method: request.method, route: routeName(url.pathname) };
    let response: Response;
    try {
      if (request.method === "OPTIONS") {
        response = new Response(null, { status: 204 });
      } else {
        response = await route(request, url, record);
      }
    } catch (err) {
      response = errorResponse(err);
      if (response.status >= 500) record.error = err instanceof Error ? err.message : String(err);
    }
    record.status = response.status;
    record.ms = Date.now() - started;
    log(record);
    return withCors(response, request.headers.get("Origin"), config.allowedOrigins);
  };

  async function route(request: Request, url: URL, record: Record<string, unknown>): Promise<Response> {
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/" && method === "GET") return html(setupPage());
    if (pathname === "/c" && method === "GET") return html(contributorPage());
    if (pathname === "/api/health" && method === "GET") {
      return json({ ok: true, backend: config.backend, connected: backend.adapter !== null });
    }

    // Moderator: the OAuth callback is authenticated by its signed state, not the admin secret,
    // because it arrives as a browser redirect from the provider.
    if (pathname === "/api/admin/connect/callback" && method === "GET") return connectCallback(url);
    if (pathname.startsWith("/api/admin/")) {
      await requireAdmin(request);
      record.admin = true;
      return adminRoute(request, url);
    }

    if (pathname.startsWith("/api/")) {
      const claims = await requireLink(request);
      record.campaign = claims.campaign;
      record.contributor = claims.contributor;
      return contributorRoute(request, url, claims, record);
    }

    throw new HttpError(404, "Not found");
  }

  // ---------------------------------------------------------------- moderator

  async function adminRoute(request: Request, url: URL): Promise<Response> {
    const { pathname } = url;
    const method = request.method;

    if (pathname === "/api/admin/status" && method === "GET") {
      return json({
        backend: config.backend,
        connected: backend.adapter !== null,
        canConnect: backend.connect !== null,
        connectProvider: backend.connect?.provider ?? null,
        redirectUri: redirectUri(url),
        appUrl: config.appUrl ?? null,
        generations: config.generations,
        maxUploadBytes: config.maxUploadBytes,
        maxProxyBytes: config.maxProxyBytes,
      });
    }

    if (pathname === "/api/admin/connect" && method === "POST") {
      if (!backend.connect) {
        throw new HttpError(409, "Set the storage app's key and secret in the gateway's secrets first.");
      }
      const state = await signState("connect", config.signingKey);
      return json({ authorizeUrl: backend.connect.authorizeUrl(redirectUri(url), state) });
    }

    if (pathname === "/api/admin/links" && method === "POST") {
      const body = await readJson(request);
      const campaign = assertSlug(String(body.campaign ?? ""), "campaign");
      const contributor = assertSlug(String(body.contributor ?? ""), "contributor");
      const permissions = parsePermissions(body.permissions);
      const expiresInDays = body.expiresInDays === undefined || body.expiresInDays === null ? undefined : Number(body.expiresInDays);
      if (expiresInDays !== undefined && !(expiresInDays > 0)) throw new HttpError(400, "expiresInDays must be positive");
      const generation = config.generations[campaign] ?? 1;
      const token = await signLink(
        {
          campaign,
          contributor,
          permissions,
          generation,
          label: typeof body.label === "string" ? body.label : undefined,
          expiresAt: expiresInDays ? Math.floor(Date.now() / 1000) + Math.round(expiresInDays * 86400) : undefined,
        },
        config.signingKey,
      );
      // The token rides in the URL fragment, which browsers never send to servers or put in logs.
      const appUrl = config.appUrl ?? `${url.origin}/c`;
      return json({ token, url: `${appUrl}#fs=${token}`, campaign, contributor, permissions, generation });
    }

    const adapter = requireAdapter();

    if (pathname === "/api/admin/campaigns" && method === "GET") {
      const entries = await adapter.list("");
      return json({ campaigns: entries.filter((e) => e.type === "folder").map((e) => e.path) });
    }

    if (pathname === "/api/admin/files") {
      const campaign = assertSlug(url.searchParams.get("campaign") ?? "", "campaign");
      const rel = normalizePath(url.searchParams.get("path") ?? "", { allowRoot: method === "GET" });
      const full = joinPath(campaign, rel);
      if (method === "GET") {
        if (url.searchParams.get("download") === "1") return fileResponse(adapter, full, rel);
        return json({ entries: (await adapter.list(full)).map((e) => relativeEntry(e, campaign)) });
      }
      if (method === "DELETE") {
        await adapter.delete(full);
        return json({ deleted: rel });
      }
    }

    throw new HttpError(404, "Not found");
  }

  async function connectCallback(url: URL): Promise<Response> {
    const state = url.searchParams.get("state") ?? "";
    const code = url.searchParams.get("code");
    if (!(await verifyState(state, "connect", config.signingKey))) {
      return html(connectResultPage({ ok: false, message: "This sign-in link is invalid or expired. Start again from the setup page." }), 400);
    }
    if (!code || !backend.connect) {
      const reason = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "No authorization code was returned.";
      return html(connectResultPage({ ok: false, message: reason }), 400);
    }
    const { refreshToken } = await backend.connect.exchange(code, redirectUri(url));
    return html(
      connectResultPage({ ok: true, provider: backend.connect.provider, secretName: backend.connect.secretName, refreshToken }),
    );
  }

  function redirectUri(url: URL): string {
    return `${url.origin}/api/admin/connect/callback`;
  }

  async function requireAdmin(request: Request): Promise<void> {
    const presented = bearer(request);
    if (!presented || !(await constantTimeEqual(presented, config.adminSecret))) {
      throw new HttpError(401, "Moderator secret required");
    }
  }

  // -------------------------------------------------------------- contributor

  async function requireLink(request: Request): Promise<LinkClaims> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, "Missing link token");
    const result = await verifyLink(token, config.signingKey, { generations: config.generations });
    if (!result.ok) {
      const messages = {
        malformed: "This link is not valid.",
        "bad-signature": "This link is not valid.",
        expired: "This link has expired. Ask the organizer for a new one.",
        revoked: "This link has been replaced. Ask the organizer for the new one.",
      } as const;
      throw new HttpError(result.reason === "expired" || result.reason === "revoked" ? 403 : 401, messages[result.reason]);
    }
    return result.claims;
  }

  async function contributorRoute(
    request: Request,
    url: URL,
    claims: LinkClaims,
    record: Record<string, unknown>,
  ): Promise<Response> {
    const { pathname } = url;
    const method = request.method;
    const writePrefix = `contributors/${claims.contributor}`;

    if (pathname === "/api/session" && method === "GET") {
      return json({
        campaign: claims.campaign,
        contributor: claims.contributor,
        label: claims.label ?? null,
        permissions: claims.permissions,
        expiresAt: claims.expiresAt ? new Date(claims.expiresAt * 1000).toISOString() : null,
        writePrefix,
        maxUploadBytes: config.maxUploadBytes,
        allowedTypes: config.allowedTypes,
        connected: backend.adapter !== null,
      });
    }

    const adapter = requireAdapter();

    if (pathname === "/api/uploads" && method === "POST") {
      need(claims, "upload");
      const body = await readJson(request);
      const rel = ownPath(String(body.path ?? ""), writePrefix);
      const size = Number(body.size);
      const contentType = String(body.contentType ?? "");
      if (!Number.isInteger(size) || size <= 0) throw new HttpError(400, "size must be a positive integer");
      checkUpload(size, contentType);
      record.bytes = size;
      if (size <= config.maxProxyBytes) {
        return json({ mode: "proxy", path: rel, method: "PUT", url: `/api/files/${encodePath(rel)}` });
      }
      const target = await adapter.createUploadTarget(joinPath(claims.campaign, rel), {
        size,
        contentType,
        origin: request.headers.get("Origin") ?? undefined,
      });
      if (!target) throw new HttpError(413, `Files over ${mb(config.maxProxyBytes)} are not supported with this storage backend.`);
      return json({ mode: "direct", path: rel, ...target });
    }

    if (pathname === "/api/files" && method === "GET") {
      need(claims, "list");
      const rel = normalizePath(url.searchParams.get("path") ?? "", { allowRoot: true });
      const entries = await adapter.list(joinPath(claims.campaign, rel));
      return json({ entries: entries.map((e) => relativeEntry(e, claims.campaign)) });
    }

    if (pathname.startsWith("/api/files/")) {
      const rel = normalizePath(decodePath(pathname.slice("/api/files/".length)));
      const full = joinPath(claims.campaign, rel);

      if (method === "GET") {
        // A contributor may always read back what they wrote themselves.
        if (!claims.permissions.includes("read") && !isWithin(rel, writePrefix)) need(claims, "read");
        if (url.searchParams.get("link") === "1") return json({ url: await adapter.getLink(full) });
        return fileResponse(adapter, full, rel);
      }

      if (method === "PUT") {
        need(claims, "upload");
        ownPath(rel, writePrefix);
        const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
        const declared = Number(request.headers.get("Content-Length") ?? "0");
        if (declared > config.maxProxyBytes) throw new HttpError(413, `Send files over ${mb(config.maxProxyBytes)} through POST /api/uploads.`);
        checkUpload(Math.max(declared, 1), contentType);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength === 0) throw new HttpError(400, "Empty file");
        if (bytes.byteLength > config.maxProxyBytes) throw new HttpError(413, "File too large");
        record.bytes = bytes.byteLength;
        const entry = await writeNoOverwrite(adapter, full, bytes, { contentType });
        return json(relativeEntry(entry, claims.campaign), 201);
      }
    }

    throw new HttpError(404, "Not found");
  }

  function checkUpload(size: number, contentType: string): void {
    if (size > config.maxUploadBytes) throw new HttpError(413, `Files must be ${mb(config.maxUploadBytes)} or smaller.`);
    if (!typeAllowed(contentType, config.allowedTypes)) throw new HttpError(415, `File type not allowed: ${contentType || "(none)"}`);
  }

  function requireAdapter(): StorageAdapter {
    if (!backend.adapter) throw new HttpError(503, "Storage is not connected yet. The organizer needs to finish setup.");
    return backend.adapter;
  }
}

// -------------------------------------------------------------------- helpers

function need(claims: LinkClaims, permission: Permission): void {
  if (!claims.permissions.includes(permission)) throw new HttpError(403, `This link does not allow ${permission}.`);
}

/** Normalizes a campaign-relative write path and confines it to the contributor's own folder. */
function ownPath(input: string, writePrefix: string): string {
  const rel = normalizePath(input);
  if (!isWithin(rel, writePrefix) || rel === writePrefix) {
    throw new HttpError(403, `Uploads must go under ${writePrefix}/`);
  }
  return rel;
}

function parsePermissions(value: unknown): Permission[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : ["upload"];
  const perms = list.map((p) => String(p).trim()).filter(Boolean);
  for (const p of perms) {
    if (!PERMISSIONS.includes(p as Permission)) throw new HttpError(400, `Unknown permission: ${p}`);
  }
  if (perms.length === 0) throw new HttpError(400, "A link needs at least one permission");
  return perms as Permission[];
}

function relativeEntry(entry: Entry, campaign: string): Entry {
  const prefix = `${campaign}/`;
  const path = entry.path.toLowerCase().startsWith(prefix.toLowerCase()) ? entry.path.slice(prefix.length) : entry.path;
  return { ...entry, path };
}

async function fileResponse(adapter: StorageAdapter, full: string, rel: string): Promise<Response> {
  const bytes = await adapter.read(full);
  return new Response(bytes as Uint8Array<ArrayBuffer>, {
    headers: {
      "Content-Type": guessType(rel),
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(rel.split("/").pop() ?? "file")}`,
    },
  });
}

const TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  json: "application/json",
  txt: "text/plain; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
};

function guessType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[ext] ?? "application/octet-stream";
}

function encodePath(rel: string): string {
  return rel.split("/").map(encodeURIComponent).join("/");
}

function decodePath(raw: string): string {
  try {
    return raw.split("/").map(decodeURIComponent).join("/");
  } catch {
    throw new InvalidPathError("Badly encoded path");
  }
}

function bearer(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new HttpError(400, "Expected a JSON object body");
}

async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function mb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
    },
  });
}

function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) return json({ error: err.message }, err.status);
  if (err instanceof InvalidPathError) return json({ error: err.message }, 400);
  if (err instanceof NotFoundError) return json({ error: "Not found" }, 404);
  if (err instanceof PathExistsError) return json({ error: "A file with that name already exists" }, 409);
  if (err instanceof ProviderError) {
    const status = err.status === 413 ? 413 : err.status === 429 ? 429 : 502;
    return json({ error: err.message }, status);
  }
  return json({ error: "Internal error" }, 500);
}

function withCors(response: Response, origin: string | null, allowed: string[]): Response {
  const headers = new Headers(response.headers);
  if (allowed.includes("*")) {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.append("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function routeName(pathname: string): string {
  if (pathname.startsWith("/api/files/")) return "/api/files/*";
  return pathname;
}
