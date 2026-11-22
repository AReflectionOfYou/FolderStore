export interface Entry {
  path: string;
  type: "file" | "folder";
  size: number;
  modifiedAt: string;
  /** Always present — adapters without a native hash must compute SHA-256 (see hash.ts). */
  contentHash: string;
}

export interface ChangesResult {
  entries: Entry[];
  cursor: string;
}

/**
 * The storage contract (spec section 5). Deliberately has no rename, move,
 * lock, or transaction, and no notion of contributor identity — all of that
 * lives in the core, not the adapter.
 */
export interface StorageAdapter {
  list(path: string): Promise<Entry[]>;
  read(path: string): Promise<Uint8Array>;
  /** Must never overwrite an existing path — throw PathExistsError instead. */
  write(path: string, bytes: Uint8Array): Promise<Entry>;
  /** Must move to a trash area, never destroy. */
  delete(path: string): Promise<void>;
  changes(cursor: string | null): Promise<ChangesResult>;
  getLink(path: string): Promise<string | null>;
}
