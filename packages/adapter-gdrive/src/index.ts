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

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id,name,mimeType,size,modifiedTime,md5Checksum";

export interface GDriveAdapterOptions {
  tokens: TokenSource;
  /**
   * Name of the top-level folder in the moderator's My Drive that holds all
   * campaigns. With the drive.file scope the gateway can only see files it
   * created itself, so it creates this folder on first use.
   */
  rootFolderName?: string;
  fetch?: typeof fetch;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
}

/**
 * Runs inside the gateway on the moderator's Google credential (spec
 * section 6.2), using the narrow drive.file scope. Drive is ID-based, not
 * path-based, so paths resolve segment by segment, with folder IDs cached
 * for the life of this object.
 *
 * Drive allows duplicate names, so never-overwrite is check-then-create.
 * Two simultaneous writes to the same new path could both succeed as
 * same-named siblings; nothing is lost, and the naming scheme makes this
 * vanishingly rare.
 */
export class GDriveAdapter implements StorageAdapter {
  private readonly tokens: TokenSource;
  private readonly rootFolderName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly folderIds = new Map<string, string>();

  constructor(opts: GDriveAdapterOptions) {
    this.tokens = opts.tokens;
    this.rootFolderName = opts.rootFolderName ?? "FolderStore";
    this.fetchImpl = opts.fetch ?? ((...args) => fetch(...args));
  }

  async list(path: string): Promise<Entry[]> {
    const folderId = await this.resolveFolder(path, false);
    if (!folderId) return [];
    return (await this.children(folderId))
      .filter((f) => !f.name.startsWith("."))
      .map((f) => toEntry(f, path ? `${path}/${f.name}` : f.name));
  }

  async read(path: string): Promise<Uint8Array> {
    const file = await this.findFile(path);
    if (!file) throw new NotFoundError(path);
    const res = await this.call(`${API}/files/${file.id}?alt=media`, { method: "GET" }, path);
    return new Uint8Array(await res.arrayBuffer());
  }

  async write(path: string, bytes: Uint8Array, opts?: WriteOptions): Promise<Entry> {
    const { dir, name } = splitPath(path);
    const parentId = await this.resolveFolder(dir, true);
    if (!parentId) throw new ProviderError("Could not create parent folder", 500);
    if (await this.findChild(parentId, name)) throw new PathExistsError(path);

    const boundary = `folderstore${crypto.randomUUID().replace(/-/g, "")}`;
    const metadata = JSON.stringify({ name, parents: [parentId] });
    const enc = new TextEncoder();
    const head = enc.encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${opts?.contentType ?? "application/octet-stream"}\r\n\r\n`,
    );
    const tail = enc.encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const res = await this.call(
      `${UPLOAD}/files?uploadType=multipart&fields=${FIELDS}`,
      { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body },
      path,
    );
    return toEntry((await res.json()) as DriveFile, path);
  }

  /** Drive has a native, recoverable trash, so delete means trashed=true. */
  async delete(path: string): Promise<void> {
    const file = await this.findFile(path);
    if (!file) throw new NotFoundError(path);
    await this.call(
      `${API}/files/${file.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }) },
      path,
    );
  }

  /**
   * List-and-compare fallback: the cursor is the newest modifiedTime seen.
   * Adequate for campaigns of a few thousand files.
   */
  async changes(cursor: string | null): Promise<ChangesResult> {
    const all = await this.walk("");
    const since = cursor ?? "";
    const entries = all.filter((e) => e.modifiedAt > since);
    const newest = all.reduce((max, e) => (e.modifiedAt > max ? e.modifiedAt : max), since);
    return { entries, cursor: newest };
  }

  /** Drive has no short-lived public link under drive.file; the gateway proxies reads. */
  async getLink(): Promise<string | null> {
    return null;
  }

  /**
   * Starts a resumable upload session; the browser PUTs the bytes to the
   * returned URL. Google binds the session's CORS to the Origin sent here.
   */
  async createUploadTarget(path: string, req: UploadTargetRequest): Promise<UploadTarget | null> {
    const { dir, name } = splitPath(path);
    const parentId = await this.resolveFolder(dir, true);
    if (!parentId) throw new ProviderError("Could not create parent folder", 500);
    if (await this.findChild(parentId, name)) throw new PathExistsError(path);
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": req.contentType,
      "X-Upload-Content-Length": String(req.size),
    };
    if (req.origin) headers.Origin = req.origin;
    const res = await this.call(
      `${UPLOAD}/files?uploadType=resumable&fields=${FIELDS}`,
      { method: "POST", headers, body: JSON.stringify({ name, parents: [parentId] }) },
      path,
    );
    const location = res.headers.get("Location");
    if (!location) throw new ProviderError("Drive did not return an upload session URL", 502);
    return {
      url: location,
      method: "PUT",
      headers: { "Content-Type": req.contentType },
      // Google keeps resumable sessions for about a week; promise much less.
      expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
    };
  }

  private async rootId(): Promise<string> {
    const cached = this.folderIds.get("");
    if (cached) return cached;
    const existing = await this.query(
      `'root' in parents and name = '${escapeQuery(this.rootFolderName)}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    );
    const id = existing[0]?.id ?? (await this.createFolder(this.rootFolderName, "root"));
    this.folderIds.set("", id);
    return id;
  }

  private async resolveFolder(path: string, create: boolean): Promise<string | null> {
    if (this.folderIds.has(path)) return this.folderIds.get(path)!;
    let currentId = await this.rootId();
    let currentPath = "";
    for (const segment of path.split("/").filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const cached = this.folderIds.get(currentPath);
      if (cached) {
        currentId = cached;
        continue;
      }
      const child = await this.findChild(currentId, segment, FOLDER_MIME);
      if (child) {
        currentId = child.id;
      } else if (create) {
        currentId = await this.createFolder(segment, currentId);
      } else {
        return null;
      }
      this.folderIds.set(currentPath, currentId);
    }
    return currentId;
  }

  private async findFile(path: string): Promise<DriveFile | null> {
    const { dir, name } = splitPath(path);
    const parentId = await this.resolveFolder(dir, false);
    if (!parentId) return null;
    const file = await this.findChild(parentId, name);
    return file && file.mimeType !== FOLDER_MIME ? file : null;
  }

  private async findChild(parentId: string, name: string, mimeType?: string): Promise<DriveFile | null> {
    let q = `'${parentId}' in parents and name = '${escapeQuery(name)}' and trashed = false`;
    if (mimeType) q += ` and mimeType = '${mimeType}'`;
    return (await this.query(q))[0] ?? null;
  }

  private async children(parentId: string): Promise<DriveFile[]> {
    return this.query(`'${parentId}' in parents and trashed = false`);
  }

  private async query(q: string): Promise<DriveFile[]> {
    const out: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ q, fields: `nextPageToken,files(${FIELDS})`, pageSize: "1000", spaces: "drive" });
      if (pageToken) params.set("pageToken", pageToken);
      const res = await this.call(`${API}/files?${params}`, { method: "GET" }, "");
      const body = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
      out.push(...(body.files ?? []));
      pageToken = body.nextPageToken;
    } while (pageToken);
    return out;
  }

  private async createFolder(name: string, parentId: string): Promise<string> {
    const res = await this.call(
      `${API}/files?fields=id`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
      },
      name,
    );
    return ((await res.json()) as { id: string }).id;
  }

  private async walk(path: string): Promise<Entry[]> {
    const result: Entry[] = [];
    for (const entry of await this.list(path)) {
      if (entry.type === "folder") result.push(...(await this.walk(entry.path)));
      else result.push(entry);
    }
    return result;
  }

  private async call(url: string, init: RequestInit & { headers?: Record<string, string> }, pathForErrors: string): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.tokens.getAccessToken(attempt > 0);
      const res = await this.fetchImpl(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
      if (res.ok) return res;
      if (res.status === 401 && attempt === 0) continue;
      const text = await res.text();
      if (res.status === 404) throw new NotFoundError(pathForErrors);
      throw new ProviderError(`Google Drive error ${res.status}`, res.status, text.slice(0, 500));
    }
    throw new ProviderError("Google authorization failed after refresh", 401);
  }
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { dir: "", name: path } : { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function toEntry(file: DriveFile, path: string): Entry {
  const isFolder = file.mimeType === FOLDER_MIME;
  return {
    path,
    type: isFolder ? "folder" : "file",
    size: isFolder ? 0 : Number(file.size ?? 0),
    modifiedAt: file.modifiedTime ?? new Date(0).toISOString(),
    contentHash: isFolder ? "" : (file.md5Checksum ?? ""),
  };
}
