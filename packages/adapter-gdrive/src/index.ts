import { google, type drive_v3 } from "googleapis";
import type { ChangesResult, Entry, StorageAdapter } from "@folderstore/core";
import { NotFoundError, PathExistsError } from "@folderstore/core";

export { authorizeGoogleDrive } from "./auth.js";

export interface GDriveAdapterOptions {
  accessToken: string;
  /** The Drive folder ID of the project root, as shared by the moderator. */
  rootFolderId: string;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";
const FIELDS = "id, name, mimeType, size, modifiedTime, md5Checksum";

/**
 * One contributor's own Google account (spec section 6), scoped to the
 * project root folder shared with them. Drive's tree is ID-based, not
 * path-based, so paths are resolved segment by segment. Untested against a
 * live account; see docs/spec.md section 11 for the drive.file open question.
 */
export class GDriveAdapter implements StorageAdapter {
  private readonly drive: drive_v3.Drive;
  private readonly rootFolderId: string;

  constructor(opts: GDriveAdapterOptions) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: opts.accessToken });
    this.drive = google.drive({ version: "v3", auth });
    this.rootFolderId = opts.rootFolderId;
  }

  async list(path: string): Promise<Entry[]> {
    const folderId = await this.resolveFolder(path, false).catch(() => null);
    if (!folderId) return [];
    const entries: Entry[] = [];
    let pageToken: string | undefined;
    do {
      const res = await this.drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: `nextPageToken, files(${FIELDS})`,
        pageToken,
      });
      for (const file of res.data.files ?? []) {
        entries.push(toEntry(file, path ? `${path}/${file.name}` : (file.name ?? "")));
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
    return entries;
  }

  async read(path: string): Promise<Uint8Array> {
    const { dir, name } = splitPath(path);
    const folderId = await this.resolveFolder(dir, false);
    const file = await this.findChild(folderId, name);
    if (!file?.id) throw new NotFoundError(path);
    const res = await this.drive.files.get(
      { fileId: file.id, alt: "media" },
      { responseType: "arraybuffer" },
    );
    return new Uint8Array(res.data as ArrayBuffer);
  }

  async write(path: string, bytes: Uint8Array): Promise<Entry> {
    const { dir, name } = splitPath(path);
    const folderId = await this.resolveFolder(dir, true);
    const existing = await this.findChild(folderId, name);
    if (existing) throw new PathExistsError(path);
    const res = await this.drive.files.create({
      requestBody: { name, parents: [folderId] },
      media: { body: Buffer.from(bytes) },
      fields: FIELDS,
    });
    return toEntry(res.data, path);
  }

  async delete(path: string): Promise<void> {
    const { dir, name } = splitPath(path);
    const folderId = await this.resolveFolder(dir, false);
    const file = await this.findChild(folderId, name);
    if (!file?.id) throw new NotFoundError(path);
    const trashFolderId = await this.resolveFolder(".trash", true);
    await this.drive.files.update({
      fileId: file.id,
      addParents: trashFolderId,
      removeParents: folderId,
      requestBody: { name: `${name}.${Date.now()}` },
    });
  }

  async changes(cursor: string | null): Promise<ChangesResult> {
    let pageToken = cursor ?? (await this.drive.changes.getStartPageToken({})).data.startPageToken;
    const entries: Entry[] = [];
    let newCursor = pageToken ?? "";
    while (pageToken) {
      const res = await this.drive.changes.list({
        pageToken,
        fields: `nextPageToken, newStartPageToken, changes(fileId, removed, file(${FIELDS}, parents))`,
      });
      for (const change of res.data.changes ?? []) {
        if (change.removed || !change.file) continue;
        entries.push(toEntry(change.file, change.file.name ?? change.fileId ?? ""));
      }
      pageToken = res.data.nextPageToken ?? undefined;
      if (res.data.newStartPageToken) newCursor = res.data.newStartPageToken;
    }
    return { entries, cursor: newCursor };
  }

  async getLink(path: string): Promise<string | null> {
    const { dir, name } = splitPath(path);
    const folderId = await this.resolveFolder(dir, false).catch(() => null);
    if (!folderId) return null;
    const file = await this.findChild(folderId, name);
    return file?.id ? `https://drive.google.com/file/d/${file.id}/view` : null;
  }

  private async resolveFolder(path: string, create: boolean): Promise<string> {
    let parentId = this.rootFolderId;
    if (!path) return parentId;
    for (const segment of path.split("/").filter(Boolean)) {
      const existing = await this.findChild(parentId, segment, FOLDER_MIME);
      if (existing?.id) {
        parentId = existing.id;
        continue;
      }
      if (!create) throw new NotFoundError(path);
      const created = await this.drive.files.create({
        requestBody: { name: segment, mimeType: FOLDER_MIME, parents: [parentId] },
        fields: "id",
      });
      if (!created.data.id) throw new Error(`Failed to create folder: ${segment}`);
      parentId = created.data.id;
    }
    return parentId;
  }

  private async findChild(
    parentId: string,
    name: string,
    mimeType?: string,
  ): Promise<drive_v3.Schema$File | null> {
    const mimeClause = mimeType ? ` and mimeType = '${mimeType}'` : "";
    const res = await this.drive.files.list({
      q: `'${parentId}' in parents and name = '${escapeQueryValue(name)}' and trashed = false${mimeClause}`,
      fields: `files(${FIELDS})`,
    });
    return res.data.files?.[0] ?? null;
  }
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? { dir: "", name: path } : { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

function toEntry(file: drive_v3.Schema$File, path: string): Entry {
  const isFolder = file.mimeType === FOLDER_MIME;
  return {
    path,
    type: isFolder ? "folder" : "file",
    size: file.size ? Number(file.size) : 0,
    modifiedAt: file.modifiedTime ?? new Date().toISOString(),
    contentHash: file.md5Checksum ?? "",
  };
}

function escapeQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}
