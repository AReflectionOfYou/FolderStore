import type {
  ChangesResult,
  Entry,
  StorageAdapter,
  TokenSource,
  UploadTarget,
  UploadTargetRequest,
  WriteOptions,
} from "@folderstore/core";
import { NotFoundError, PathExistsError, ProviderError } from "@folderstore/core";

export * from "./oauth.js";

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const TRASH = ".trash";
/** Dropbox's single-request upload limit; larger files need upload sessions (not yet supported). */
export const DROPBOX_SINGLE_UPLOAD_LIMIT = 150 * 1024 * 1024;

export interface DropboxAdapterOptions {
  tokens: TokenSource;
  /**
   * Folder inside the app's view of Dropbox. With "App folder" access the
   * app's view is Apps/<app name>/, so "" means that folder itself.
   */
  root?: string;
  fetch?: typeof fetch;
}

/**
 * Runs inside the gateway on the moderator's Dropbox credential (spec
 * section 6.1). Plain fetch, no SDK, so it runs on Cloudflare Workers.
 */
export class DropboxAdapter implements StorageAdapter {
  private readonly tokens: TokenSource;
  private readonly root: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: DropboxAdapterOptions) {
    this.tokens = opts.tokens;
    this.root = (opts.root ?? "").replace(/^\/+|\/+$/g, "");
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
  }

  /** Dropbox wants "" for the root and "/a/b" otherwise. */
  private full(path: string): string {
    const joined = [this.root, path].filter(Boolean).join("/");
    return joined ? `/${joined}` : "";
  }

  private relative(pathDisplay: string): string {
    const prefix = this.root ? `/${this.root}` : "";
    if (prefix && pathDisplay.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) {
      return pathDisplay.slice(prefix.length + 1);
    }
    return pathDisplay.replace(/^\//, "");
  }

  async list(path: string): Promise<Entry[]> {
    let page: ListFolderResult;
    try {
      page = await this.rpc<ListFolderResult>("/files/list_folder", { path: this.full(path) });
    } catch (err) {
      if (err instanceof NotFoundError) return [];
      throw err;
    }
    const entries: Entry[] = [];
    for (;;) {
      for (const item of page.entries) {
        if (item.name.startsWith(".")) continue;
        if (item[".tag"] === "deleted") continue;
        entries.push(toEntry(item, this.relative(item.path_display)));
      }
      if (!page.has_more) break;
      page = await this.rpc<ListFolderResult>("/files/list_folder/continue", { cursor: page.cursor });
    }
    return entries;
  }

  async read(path: string): Promise<Uint8Array> {
    const res = await this.call(`${CONTENT}/files/download`, {
      headers: { "Dropbox-API-Arg": headerJson({ path: this.full(path) }) },
    }, path);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, bytes: Uint8Array, _opts?: WriteOptions): Promise<Entry> {
    if (bytes.byteLength > DROPBOX_SINGLE_UPLOAD_LIMIT) {
      throw new ProviderError("File too large for a single Dropbox upload", 413);
    }
    const res = await this.call(`${CONTENT}/files/upload`, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": headerJson({ path: this.full(path), mode: "add", autorename: false, mute: true }),
      },
      body: bytes as Uint8Array<ArrayBuffer>,
    }, path);
    return toEntry((await res.json()) as DropboxMetadata, path);
  }

  async delete(path: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "");
    await this.rpc("/files/move_v2", {
      from_path: this.full(path),
      to_path: this.full(`${TRASH}/${path}.${stamp}`),
      autorename: true,
    }, path);
  }

  async changes(cursor: string | null): Promise<ChangesResult> {
    let page = cursor
      ? await this.rpc<ListFolderResult>("/files/list_folder/continue", { cursor })
      : await this.rpc<ListFolderResult>("/files/list_folder", { path: this.full(""), recursive: true });
    const entries: Entry[] = [];
    for (;;) {
      for (const item of page.entries) {
        if (item[".tag"] !== "file") continue;
        const rel = this.relative(item.path_display);
        if (rel.split("/").some((seg) => seg.startsWith("."))) continue;
        entries.push(toEntry(item, rel));
      }
      if (!page.has_more) break;
      page = await this.rpc<ListFolderResult>("/files/list_folder/continue", { cursor: page.cursor });
    }
    return { entries, cursor: page.cursor };
  }

  async getLink(path: string): Promise<string | null> {
    try {
      const res = await this.rpc<{ link: string }>("/files/get_temporary_link", { path: this.full(path) }, path);
      return res.link;
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * A one-time upload URL the browser POSTs the raw bytes to. The commit
   * uses mode "add" with autorename off, so an existing file is never
   * replaced: the upload fails with a conflict instead.
   */
  async createUploadTarget(path: string, req: UploadTargetRequest): Promise<UploadTarget | null> {
    if (req.size > DROPBOX_SINGLE_UPLOAD_LIMIT) {
      throw new ProviderError("File too large for a single Dropbox upload", 413);
    }
    const durationSeconds = 3600;
    const res = await this.rpc<{ link: string }>("/files/get_temporary_upload_link", {
      commit_info: { path: this.full(path), mode: "add", autorename: false, mute: true },
      duration: durationSeconds,
    }, path);
    return {
      url: res.link,
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      expiresAt: new Date(Date.now() + durationSeconds * 1000).toISOString(),
    };
  }

  private async rpc<T = unknown>(endpoint: string, body: unknown, pathForErrors = ""): Promise<T> {
    const res = await this.call(`${API}${endpoint}`, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, pathForErrors);
    return (await res.json()) as T;
  }

  /** POST with a bearer token; refreshes once on 401 and maps Dropbox errors. */
  private async call(
    url: string,
    init: { headers: Record<string, string>; body?: BodyInit },
    pathForErrors: string,
  ): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.getAccessToken(attempt > 0);
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        body: init.body,
      });
      if (res.ok) return res;
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      if (res.status === 409) {
        let summary = text;
        try {
          summary = (JSON.parse(text) as { error_summary?: string }).error_summary ?? text;
        } catch {
          // keep raw text
        }
        if (/not_found/.test(summary)) throw new NotFoundError(pathForErrors);
        if (/conflict/.test(summary)) throw new PathExistsError(pathForErrors);
        throw new ProviderError(`Dropbox refused the request: ${summary}`, 409, summary);
      }
      throw new ProviderError(`Dropbox error ${res.status}`, res.status, text.slice(0, 500));
    }
    throw new ProviderError("Dropbox authorization failed after refresh", 401);
  }
}

interface DropboxMetadata {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_display: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

interface ListFolderResult {
  entries: DropboxMetadata[];
  cursor: string;
  has_more: boolean;
}

function toEntry(item: DropboxMetadata, relativePath: string): Entry {
  const isFile = item[".tag"] === "file";
  return {
    path: relativePath,
    type: isFile ? "file" : "folder",
    size: isFile ? (item.size ?? 0) : 0,
    modifiedAt: item.server_modified ?? new Date(0).toISOString(),
    // Dropbox's own content_hash algorithm, not SHA-256.
    contentHash: isFile ? (item.content_hash ?? "") : "",
  };
}

/** Dropbox-API-Arg must be ASCII; non-ASCII characters are sent as \uXXXX escapes. */
export function headerJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
