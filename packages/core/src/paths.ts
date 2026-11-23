import { InvalidPathError } from "./errors.js";

/** Campaign and contributor IDs: lowercase letters, digits, and hyphens. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isSlug(value: string): boolean {
  return SLUG.test(value);
}

export function assertSlug(value: string, what: string): string {
  if (!isSlug(value)) throw new InvalidPathError(`${what} must be 1-64 lowercase letters, digits, or hyphens: ${value}`);
  return value;
}

/**
 * Normalizes a caller-supplied relative path and refuses anything that could
 * escape its root: absolute paths, "..", empty or dot segments, backslashes,
 * control characters, and names reserved by the library (leading "." such as
 * ".trash"). Returns "" for the root itself when allowRoot is true.
 */
export function normalizePath(input: string, opts: { allowRoot?: boolean } = {}): string {
  if (typeof input !== "string") throw new InvalidPathError("Path must be a string");
  if (/[\u0000-\u001f\u007f\\]/.test(input)) throw new InvalidPathError(`Illegal character in path: ${input}`);
  const trimmed = input.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") {
    if (opts.allowRoot) return "";
    throw new InvalidPathError("Path is empty");
  }
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") throw new InvalidPathError(`Illegal path segment in: ${input}`);
    if (seg.startsWith(".")) throw new InvalidPathError(`Hidden or reserved name in path: ${input}`);
    if (seg.length > 200) throw new InvalidPathError(`Path segment too long in: ${input}`);
  }
  if (trimmed.length > 900) throw new InvalidPathError("Path too long");
  return segments.join("/");
}

export function joinPath(...parts: string[]): string {
  return parts.filter((p) => p !== "").join("/");
}

/** True when path equals prefix or sits underneath it. */
export function isWithin(path: string, prefix: string): boolean {
  if (prefix === "") return true;
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Reduces an arbitrary user filename to a safe single path segment. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 120);
}
