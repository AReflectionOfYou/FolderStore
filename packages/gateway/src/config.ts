// Gateway configuration comes entirely from environment variables and
// secrets (spec section 8), so switching backends is a configuration change,
// never a code change. Values are strings because that is what every
// platform's secret store holds.

export type Env = Record<string, string | undefined>;

export type BackendName = "dropbox" | "gdrive" | "local";

export interface GatewayConfig {
  backend: BackendName;
  signingKey: string;
  adminSecret: string;
  /** Front-end page that contributor links open, e.g. https://you.github.io/PhotoStories/. */
  appUrl?: string;
  /** Origins allowed to call the gateway from a browser; ["*"] allows any. */
  allowedOrigins: string[];
  /** Largest file a contributor may upload at all, in bytes. */
  maxUploadBytes: number;
  /** Largest body the gateway accepts itself; bigger files must go direct to storage. */
  maxProxyBytes: number;
  /** MIME patterns contributors may upload, e.g. "image/*". */
  allowedTypes: string[];
  /** Current link generation per campaign; links below it are revoked. */
  generations: Record<string, number>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const MB = 1024 * 1024;

export const DEFAULT_ALLOWED_TYPES = [
  "image/*",
  "video/*",
  "audio/*",
  "application/json",
  "text/plain",
  "text/vtt",
];

export function loadConfig(env: Env): GatewayConfig {
  const backend = (env.STORAGE_BACKEND ?? "dropbox").trim() as BackendName;
  if (!["dropbox", "gdrive", "local"].includes(backend)) {
    throw new ConfigError(`STORAGE_BACKEND must be dropbox, gdrive, or local (got "${backend}")`);
  }
  const signingKey = env.SIGNING_KEY ?? "";
  if (signingKey.length < 32) throw new ConfigError("SIGNING_KEY is missing or shorter than 32 characters");
  const adminSecret = env.ADMIN_SECRET ?? "";
  if (adminSecret.length < 16) throw new ConfigError("ADMIN_SECRET is missing or shorter than 16 characters");

  const appUrl = env.APP_URL?.trim() || undefined;
  let allowedOrigins = splitList(env.ALLOWED_ORIGINS);
  if (allowedOrigins.length === 0) allowedOrigins = appUrl ? [new URL(appUrl).origin] : ["*"];

  let generations: Record<string, number> = {};
  if (env.LINK_GENERATIONS?.trim()) {
    try {
      generations = JSON.parse(env.LINK_GENERATIONS);
    } catch {
      throw new ConfigError('LINK_GENERATIONS must be JSON, e.g. {"smith-family": 2}');
    }
  }

  return {
    backend,
    signingKey,
    adminSecret,
    appUrl,
    allowedOrigins,
    maxUploadBytes: megabytes(env.MAX_UPLOAD_MB, 150),
    // Cloudflare's free plan caps request bodies at 100 MB and Vercel's at
    // about 4.5 MB; 4 MB is safe everywhere. Raise it on Cloudflare if wanted.
    maxProxyBytes: megabytes(env.MAX_PROXY_UPLOAD_MB, 4),
    allowedTypes: splitList(env.ALLOWED_TYPES).length ? splitList(env.ALLOWED_TYPES) : DEFAULT_ALLOWED_TYPES,
    generations,
  };
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function megabytes(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback * MB;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`Expected a positive number of megabytes, got "${value}"`);
  return Math.floor(n * MB);
}

export function typeAllowed(contentType: string, patterns: string[]): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type)) return false;
  return patterns.some((p) => {
    const pattern = p.toLowerCase();
    return pattern.endsWith("/*") ? type.startsWith(pattern.slice(0, -1)) : type === pattern;
  });
}
