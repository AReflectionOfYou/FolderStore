import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { ChangesResult, Entry, StorageAdapter, UploadTarget } from "@folderstore/core";
import { NotFoundError, PathExistsError, sha256Hex } from "@folderstore/core";

const TRASH_DIR = ".trash";

/** For tests, development, and running a gateway on your own machine (spec section 6.4). */
export class LocalAdapter implements StorageAdapter {
  constructor(private readonly root: string) {}

  private resolve(path: string): string {
    const full = join(this.root, path);
    const rel = relative(this.root, full);
    if (rel.split(sep).includes("..")) {
      throw new Error(`Path escapes project root: ${path}`);
    }
    return full;
  }

  async list(path: string): Promise<Entry[]> {
    const dirPath = this.resolve(path);
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const entries: Entry[] = [];
    for (const name of names) {
      if (path === "" && name === TRASH_DIR) continue;
      const childPath = path ? `${path}/${name}` : name;
      entries.push(await this.describe(childPath));
    }
    return entries;
  }

  async read(path: string): Promise<Uint8Array> {
    try {
      return await readFile(this.resolve(path));
    } catch (err) {
      if (isEnoent(err)) throw new NotFoundError(path);
      throw err;
    }
  }

  async write(path: string, bytes: Uint8Array): Promise<Entry> {
    const full = this.resolve(path);
    await mkdir(dirname(full), { recursive: true });
    try {
      await writeFile(full, bytes, { flag: "wx" });
    } catch (err) {
      if (isEexist(err)) throw new PathExistsError(path);
      throw err;
    }
    return this.describe(path);
  }

  async delete(path: string): Promise<void> {
    const full = this.resolve(path);
    let trashTarget = join(this.root, TRASH_DIR, path);
    await mkdir(dirname(trashTarget), { recursive: true });
    let attempt = 0;
    while (await pathExists(trashTarget)) {
      attempt += 1;
      trashTarget = join(this.root, TRASH_DIR, `${path}.${Date.now()}.${attempt}`);
    }
    try {
      await rename(full, trashTarget);
    } catch (err) {
      if (isEnoent(err)) throw new NotFoundError(path);
      throw err;
    }
  }

  async changes(cursor: string | null): Promise<ChangesResult> {
    const since = cursor ? new Date(cursor) : new Date(0);
    const all = await this.walk("");
    const entries = all.filter((entry) => new Date(entry.modifiedAt) > since);
    return { entries, cursor: new Date().toISOString() };
  }

  async getLink(_path: string): Promise<string | null> {
    // A file:// URL is useless to a browser talking to a gateway; the gateway proxies reads instead.
    return null;
  }

  async createUploadTarget(): Promise<UploadTarget | null> {
    return null;
  }

  private async describe(path: string): Promise<Entry> {
    const full = this.resolve(path);
    const info = await stat(full);
    if (info.isDirectory()) {
      return { path, type: "folder", size: 0, modifiedAt: info.mtime.toISOString(), contentHash: "" };
    }
    const bytes = await readFile(full);
    return {
      path,
      type: "file",
      size: info.size,
      modifiedAt: info.mtime.toISOString(),
      contentHash: await sha256Hex(bytes),
    };
  }

  private async walk(path: string): Promise<Entry[]> {
    const entries = await this.list(path);
    const result: Entry[] = [];
    for (const entry of entries) {
      if (entry.type === "folder") {
        result.push(...(await this.walk(entry.path)));
      } else {
        result.push(entry);
      }
    }
    return result;
  }
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function isEexist(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
