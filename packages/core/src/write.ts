import type { StorageAdapter, Entry, WriteOptions } from "./contract.js";
import { PathExistsError } from "./errors.js";
import { disambiguate } from "./naming.js";

export interface WriteNoOverwriteOptions extends WriteOptions {
  maxRetries?: number;
  /** Produces a short, random disambiguating suffix on each retry. */
  disambiguator?: () => string;
}

/**
 * Spec sections 5 and 10.2: write() never overwrites. On a path collision — most
 * often the same contributor writing from two devices at once — retry with a
 * disambiguated name instead of failing visibly or clobbering the original.
 */
export async function writeNoOverwrite(
  adapter: StorageAdapter,
  path: string,
  bytes: Uint8Array,
  opts: WriteNoOverwriteOptions = {},
): Promise<Entry> {
  const maxRetries = opts.maxRetries ?? 5;
  const disambiguator = opts.disambiguator ?? (() => Math.random().toString(36).slice(2, 8));

  let candidate = path;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await adapter.write(candidate, bytes, { contentType: opts.contentType });
    } catch (err) {
      if (err instanceof PathExistsError && attempt < maxRetries) {
        candidate = disambiguate(path, disambiguator());
        continue;
      }
      throw err;
    }
  }
  throw new PathExistsError(path);
}

/** The disambiguated path writeNoOverwrite would try next, for direct uploads that collide. */
export function nextCandidatePath(path: string, disambiguator = () => Math.random().toString(36).slice(2, 8)): string {
  return disambiguate(path, disambiguator());
}
