// Browser client for a FolderStore gateway (spec section 6). Apps use this
// instead of calling the gateway's HTTP API by hand. It has no dependencies
// beyond the core's naming helpers and runs in any browser, or in Node 18+
// for tests.
//
// Path conventions:
//   - upload(), writeJson(), uploadWithSidecar() take paths relative to the
//     contributor's own folder, e.g. "media/IMG_0412.jpg". The client adds
//     the "contributors/<id>/" prefix.
//   - list(), read(), readJson(), mediaUrl() take campaign-relative paths,
//     e.g. "contributors/amy/media/IMG_0412.jpg", as returned by list() and
//     by the upload methods.

import { disambiguate } from "@folderstore/core/naming";

export type Permission = "upload" | "list" | "read";

export interface Session {
  campaign: string;
  contributor: string;
  label: string | null;
  permissions: Permission[];
  expiresAt: string | null;
  /** Campaign-relative folder this link may write into, e.g. "contributors/amy". */
  writePrefix: string;
  maxUploadBytes: number;
  allowedTypes: string[];
  /** False until the organizer has finished connecting storage. */
  connected: boolean;
}

export interface Entry {
  path: string;
  type: "file" | "folder";
  size: number;
  modifiedAt: string;
  contentHash: string;
}

export interface UploadOptions {
  /** Defaults to the Blob's own type, then application/octet-stream. */
  contentType?: string;
  /** Called with a fraction from 0 to 1 while bytes are sent. Needs XMLHttpRequest (browsers). */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

export interface UploadResult {
  /** Campaign-relative path the file was saved under; may differ from the requested name after a collision. */
  path: string;
  size: number;
  /** "proxy" went through the gateway; "direct" went straight to storage. */
  mode: "proxy" | "direct";
}

export interface ClientOptions {
  /** The gateway's base URL, e.g. "https://folderstore-gateway.example.workers.dev". */
  gatewayUrl: string;
  /** The contributor link token (see readLinkToken). */
  token: string;
  /** Override fetch, e.g. for tests. */
  fetch?: typeof fetch;
}

export class FolderStoreError extends Error {
  constructor(
    message: string,
    /** HTTP status from the gateway or storage; 0 for network failures. */
    public readonly status: number,
  ) {
    super(message);
    this.name = "FolderStoreError";
  }
}

const MAX_NAME_ATTEMPTS = 5;

export class FolderStoreClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private sessionPromise: Promise<Session> | null = null;

  constructor(opts: ClientOptions) {
    if (!opts.token) throw new Error("A link token is required");
    this.base = opts.gatewayUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
  }

  /** What this link allows. Cached after the first call. */
  session(): Promise<Session> {
    this.sessionPromise ??= this.json<Session>("GET", "/api/session").catch((err) => {
      this.sessionPromise = null;
      throw err;
    });
    return this.sessionPromise;
  }

  /**
   * Uploads one file into the contributor's own folder. Small files go
   * through the gateway; large ones straight to storage. Never overwrites:
   * on a name collision the file is saved under a disambiguated name, which
   * the result reports.
   */
  async upload(file: Blob, ownPath: string, opts: UploadOptions = {}): Promise<UploadResult> {
    const session = await this.session();
    const contentType = opts.contentType || file.type || "application/octet-stream";
    if (file.size === 0) throw new FolderStoreError("The file is empty", 400);
    if (file.size > session.maxUploadBytes) {
      throw new FolderStoreError(`Files must be ${formatMb(session.maxUploadBytes)} or smaller`, 413);
    }
    const requested = `${session.writePrefix}/${trimSlashes(ownPath)}`;

    let path = requested;
    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt++) {
      const plan = await this.json<UploadPlan>("POST", "/api/uploads", { path, size: file.size, contentType });
      if (plan.mode === "proxy") {
        const res = await this.send("PUT", this.url(plan.url), { ...this.auth(), "Content-Type": contentType }, file, opts);
        if (res.status === 201 || res.status === 200) {
          const entry = JSON.parse(res.text) as Entry;
          return { path: entry.path, size: entry.size, mode: "proxy" };
        }
        throw await errorFrom(res);
      }
      const res = await this.send(plan.method, plan.url, plan.headers, file, opts);
      if (res.status >= 200 && res.status < 300) return { path: plan.path, size: file.size, mode: "direct" };
      if (res.status !== 409) throw new FolderStoreError(`Upload to storage failed (${res.status})`, res.status);
      path = disambiguate(requested, randomSuffix());
    }
    throw new FolderStoreError("Could not find a free file name", 409);
  }

  /** Writes a JSON file into the contributor's own folder. Never overwrites. */
  async writeJson(ownPath: string, value: unknown): Promise<UploadResult> {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    return this.upload(blob, ownPath, { contentType: "application/json" });
  }

  /**
   * Uploads a file and then its sidecar, which shares the file's root name
   * (spec section 10.2), e.g. media/IMG_0412.jpg and media/IMG_0412.json.
   * If the file was renamed after a collision, the sidecar follows the new
   * name.
   */
  async uploadWithSidecar(
    file: Blob,
    ownPath: string,
    sidecar: unknown,
    opts: UploadOptions = {},
  ): Promise<{ file: UploadResult; sidecar: UploadResult }> {
    const session = await this.session();
    const saved = await this.upload(file, ownPath, opts);
    const ownSaved = saved.path.slice(session.writePrefix.length + 1);
    const sidecarResult = await this.writeJson(sidecarPathFor(ownSaved), sidecar);
    return { file: saved, sidecar: sidecarResult };
  }

  /** Lists one folder in the campaign (campaign-relative path; "" for the top). */
  async list(path = ""): Promise<Entry[]> {
    const res = await this.json<{ entries: Entry[] }>("GET", `/api/files?path=${encodeURIComponent(trimSlashes(path))}`);
    return res.entries;
  }

  /** Lists every file under a folder, descending into subfolders. */
  async listAll(path = "", maxDepth = 8): Promise<Entry[]> {
    const out: Entry[] = [];
    const walk = async (folder: string, depth: number): Promise<void> => {
      for (const entry of await this.list(folder)) {
        if (entry.type === "file") out.push(entry);
        else if (depth < maxDepth) await walk(entry.path, depth + 1);
      }
    };
    await walk(path, 0);
    return out;
  }

  /** Reads a file (campaign-relative path). */
  async read(path: string): Promise<Blob> {
    const res = await this.fetchImpl(this.url(`/api/files/${encodePath(path)}`), { headers: this.auth() });
    if (!res.ok) throw await errorFromResponse(res);
    return res.blob();
  }

  async readJson<T = unknown>(path: string): Promise<T> {
    return JSON.parse(await (await this.read(path)).text()) as T;
  }

  /**
   * A URL suitable for <img src> or <video src>: a short-lived storage link
   * where the backend offers one, otherwise an object URL of the bytes. Call
   * URL.revokeObjectURL on "blob:" URLs when done with them.
   */
  async mediaUrl(path: string): Promise<string> {
    const { url } = await this.json<{ url: string | null }>("GET", `/api/files/${encodePath(path)}?link=1`);
    if (url) return url;
    return URL.createObjectURL(await this.read(path));
  }

  // ------------------------------------------------------------------ private

  private auth(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private url(path: string): string {
    return /^https?:\/\//.test(path) ? path : `${this.base}${path}`;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path), {
        method,
        headers: body === undefined ? this.auth() : { ...this.auth(), "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new FolderStoreError(`Could not reach the gateway: ${err instanceof Error ? err.message : err}`, 0);
    }
    if (!res.ok) throw await errorFromResponse(res);
    return (await res.json()) as T;
  }

  /** Sends bytes with progress via XMLHttpRequest when available, otherwise fetch. */
  private async send(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: Blob,
    opts: UploadOptions,
  ): Promise<SendResult> {
    if (opts.onProgress && typeof XMLHttpRequest !== "undefined") {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open(method, url);
        for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) opts.onProgress!(e.loaded / e.total);
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) opts.onProgress!(1);
          resolve({ status: xhr.status, text: xhr.responseText });
        };
        xhr.onerror = () => reject(new FolderStoreError("Network error during upload", 0));
        xhr.onabort = () => reject(new FolderStoreError("Upload cancelled", 0));
        opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
        xhr.send(body);
      });
    }
    try {
      const res = await this.fetchImpl(url, { method, headers, body, signal: opts.signal });
      const text = await res.text();
      if (res.ok) opts.onProgress?.(1);
      return { status: res.status, text };
    } catch (err) {
      throw new FolderStoreError(`Network error during upload: ${err instanceof Error ? err.message : err}`, 0);
    }
  }
}

// -------------------------------------------------------------------- helpers

/**
 * Reads a link token from the page URL's fragment ("#fs=<token>"), keeps it
 * in sessionStorage so a reload still works, and removes it from the address
 * bar so it isn't bookmarked or shared by accident. Returns null when there
 * is no token.
 */
export function readLinkToken(
  loc: { hash: string; pathname: string; search: string } = location,
  storageKey = "folderstore-link",
): string | null {
  const params = new URLSearchParams(loc.hash.replace(/^#/, ""));
  const fromHash = params.get("fs");
  const storage = safeSessionStorage();
  if (fromHash) {
    storage?.setItem(storageKey, fromHash);
    if (typeof history !== "undefined") {
      params.delete("fs");
      const rest = params.toString();
      history.replaceState(null, "", `${loc.pathname}${loc.search}${rest ? `#${rest}` : ""}`);
    }
    return fromHash;
  }
  return storage?.getItem(storageKey) ?? null;
}

/** media/IMG_0412.jpg → media/IMG_0412.json */
export function sidecarPathFor(path: string): string {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return (dot > slash ? path.slice(0, dot) : path) + ".json";
}

/**
 * A collision-resistant file name for an upload: UTC timestamp, then the
 * cleaned original name, e.g. "20261122T201125Z_IMG_0412.jpg".
 */
export function timestampedName(originalName: string, when: Date = new Date()): string {
  const stamp = when.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}_${cleanName(originalName)}`;
}

/** Reduces an arbitrary file name to a safe single path segment. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 120);
}

interface UploadPlan {
  mode: "proxy" | "direct";
  path: string;
  url: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
}

interface SendResult {
  status: number;
  text: string;
}

async function errorFromResponse(res: Response): Promise<FolderStoreError> {
  return errorFrom({ status: res.status, text: await res.text() });
}

async function errorFrom(res: SendResult): Promise<FolderStoreError> {
  let message = `Request failed (${res.status})`;
  try {
    const body = JSON.parse(res.text) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // not JSON
  }
  return new FolderStoreError(message, res.status);
}

function encodePath(path: string): string {
  return trimSlashes(path).split("/").map(encodeURIComponent).join("/");
}

function trimSlashes(path: string): string {
  return path.replace(/^\/+|\/+$/g, "");
}

function randomSuffix(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 6);
}

function formatMb(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}
