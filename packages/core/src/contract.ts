export interface Entry {
  path: string;
  type: "file" | "folder";
  size: number;
  modifiedAt: string;
  /**
   * Present for files. Adapters report the provider's native hash where one
   * exists (Dropbox content_hash, Drive md5Checksum) and SHA-256 otherwise.
   * Bag exports compute SHA-256 independently (spec section 12).
   */
  contentHash: string;
}

export interface ChangesResult {
  entries: Entry[];
  cursor: string;
}

/**
 * Where a browser should send a file's bytes directly, bypassing the gateway
 * (spec section 6.3). The URL is short-lived and good for one file only.
 */
export interface UploadTarget {
  url: string;
  method: "POST" | "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}

export interface WriteOptions {
  contentType?: string;
}

export interface UploadTargetRequest {
  size: number;
  contentType: string;
  /** The browser origin that will send the bytes, for providers that bind CORS to it (Google Drive). */
  origin?: string;
}

/**
 * The storage contract (spec section 5). Adapters run server-side, inside the
 * gateway, on the storage owner's credential. They know nothing about
 * contributors, campaigns, or permissions — all of that lives in the gateway
 * and core. Deliberately no rename, move, lock, or transaction.
 *
 * Paths are relative to the adapter's root, use "/" separators, and have
 * already been normalized by the caller (see paths.ts).
 */
export interface StorageAdapter {
  list(path: string): Promise<Entry[]>;
  read(path: string): Promise<Uint8Array>;
  /** Must never overwrite an existing path — throw PathExistsError instead. */
  write(path: string, bytes: Uint8Array, opts?: WriteOptions): Promise<Entry>;
  /** Must move to a trash area (or the provider's own trash), never destroy. */
  delete(path: string): Promise<void>;
  changes(cursor: string | null): Promise<ChangesResult>;
  /** Optional short-lived download link for media display; null if unsupported. */
  getLink(path: string): Promise<string | null>;
  /**
   * Optional direct-upload target for large files. Must preserve the
   * never-overwrite rule (the upload fails rather than replacing a file).
   * Returns null when the adapter has no direct path; the gateway then
   * accepts the bytes itself, within its own body-size limit.
   */
  createUploadTarget(path: string, req: UploadTargetRequest): Promise<UploadTarget | null>;
}

/** Supplies an adapter with the storage owner's short-lived access token. */
export interface TokenSource {
  /** Returns a valid access token; force=true discards any cached one. */
  getAccessToken(force?: boolean): Promise<string>;
}
