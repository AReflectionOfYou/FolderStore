import { Dropbox } from "dropbox";
import type { ChangesResult, Entry, StorageAdapter } from "@folderstore/core";
import { NotFoundError, PathExistsError } from "@folderstore/core";

export { authorizeDropbox } from "./auth.js";

export interface DropboxAdapterOptions {
  accessToken: string;
  /** Path to the project root as it appears in this contributor's own Dropbox, e.g. "/FamilyPhotos". */
  root: string;
}

function joinPath(root: string, path: string): string {
  const joined = `${root}/${path}`.replace(/\/+/g, "/").replace(/\/$/, "");
  return joined === "" ? "" : joined;
}

/**
 * One contributor's own Dropbox account (spec section 6) — no project-owned
 * shared token. Untested against a live account; see docs/spec.md section 11.
 */
export class DropboxAdapter implements StorageAdapter {
  private readonly dbx: Dropbox;
  private readonly root: string;

  constructor(opts: DropboxAdapterOptions) {
    this.dbx = new Dropbox({ accessToken: opts.accessToken, fetch });
    this.root = opts.root.replace(/\/$/, "");
  }

  async list(path: string): Promise<Entry[]> {
    const fullPath = joinPath(this.root, path);
    const entries: Entry[] = [];
    let res = await this.dbx.filesListFolder({ path: fullPath });
    for (;;) {
      for (const item of res.result.entries) {
        const relativePath = path ? `${path}/${item.name}` : item.name;
        entries.push(toEntry(item, relativePath));
      }
      if (!res.result.has_more) break;
      res = await this.dbx.filesListFolderContinue({ cursor: res.result.cursor });
    }
    return entries;
  }

  async read(path: string): Promise<Uint8Array> {
    const fullPath = joinPath(this.root, path);
    try {
      const res = await this.dbx.filesDownload({ path: fullPath });
      const binary = (res.result as { fileBinary?: Uint8Array | Buffer }).fileBinary;
      if (!binary) throw new NotFoundError(path);
      return new Uint8Array(binary);
    } catch (err) {
      if (isStatus(err, 409)) throw new NotFoundError(path);
      throw err;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<Entry> {
    const fullPath = joinPath(this.root, path);
    try {
      const res = await this.dbx.filesUpload({
        path: fullPath,
        contents: bytes,
        mode: { ".tag": "add" },
        autorename: false,
      });
      return toEntry(res.result, path);
    } catch (err) {
      if (isStatus(err, 409)) throw new PathExistsError(path);
      throw err;
    }
  }

  async delete(path: string): Promise<void> {
    const fullPath = joinPath(this.root, path);
    const trashPath = joinPath(this.root, `.trash/${path}.${Date.now()}`);
    try {
      await this.dbx.filesMoveV2({ from_path: fullPath, to_path: trashPath, autorename: true });
    } catch (err) {
      if (isStatus(err, 409)) throw new NotFoundError(path);
      throw err;
    }
  }

  async changes(cursor: string | null): Promise<ChangesResult> {
    let page = cursor
      ? await this.dbx.filesListFolderContinue({ cursor })
      : await this.dbx.filesListFolder({ path: this.root, recursive: true });

    const entries: Entry[] = [];
    for (;;) {
      for (const item of page.result.entries) {
        if (item[".tag"] === "deleted") continue;
        const relativePath = (item.path_lower ?? "").slice(this.root.length).replace(/^\//, "");
        entries.push(toEntry(item, relativePath));
      }
      if (!page.result.has_more) break;
      page = await this.dbx.filesListFolderContinue({ cursor: page.result.cursor });
    }
    return { entries, cursor: page.result.cursor };
  }

  async getLink(path: string): Promise<string | null> {
    const fullPath = joinPath(this.root, path);
    try {
      const res = await this.dbx.filesGetTemporaryLink({ path: fullPath });
      return res.result.link;
    } catch {
      return null;
    }
  }
}

interface DropboxMetadataLike {
  [".tag"]?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

function toEntry(item: DropboxMetadataLike, relativePath: string): Entry {
  const isFile = item[".tag"] === "file";
  return {
    path: relativePath,
    type: isFile ? "file" : "folder",
    size: isFile ? item.size ?? 0 : 0,
    modifiedAt: isFile ? item.server_modified ?? new Date().toISOString() : new Date().toISOString(),
    // Dropbox's own content_hash algorithm, not SHA-256 — fine for this adapter's own
    // change detection; bag exports (spec section 12.1) compute SHA-256 independently.
    contentHash: isFile ? item.content_hash ?? "" : "",
  };
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status?: number }).status === status;
}
