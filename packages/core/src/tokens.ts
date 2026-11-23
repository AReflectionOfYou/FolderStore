// Self-verifying contributor link tokens (spec section 4).
//
// A token is "fs1.<payload>.<signature>": base64url JSON claims, signed with
// HMAC-SHA256 using the gateway's SIGNING_KEY. The gateway needs no database
// to check one. Revocation is by generation number (per campaign) or by
// rotating the signing key (everything).

import { base64UrlDecode, base64UrlEncode, randomId } from "./hash.js";
import { isSlug } from "./paths.js";

export type Permission = "upload" | "list" | "read";

const PERMISSION_CODES: Record<Permission, string> = { upload: "u", list: "l", read: "r" };
const CODE_TO_PERMISSION: Record<string, Permission> = { u: "upload", l: "list", r: "read" };

export interface LinkClaims {
  /** Campaign slug: one campaign is one folder under the storage root. */
  campaign: string;
  /** Contributor slug: this link writes only under contributors/<contributor>/. */
  contributor: string;
  permissions: Permission[];
  /** Must be >= the campaign's current generation (config LINK_GENERATIONS). */
  generation: number;
  /** Seconds since the epoch; absent means no expiry. */
  expiresAt?: number;
  /** Optional human label shown to the moderator, e.g. "Guests" or "Aunt Rose". */
  label?: string;
  /** Random per-link ID, so two links with identical claims still differ. */
  id: string;
}

interface WireClaims {
  v: 1;
  c: string;
  u: string;
  p: string;
  g: number;
  e?: number;
  n?: string;
  i: string;
}

const PREFIX = "fs1";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) throw new Error("SIGNING_KEY must be at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signLink(
  claims: Omit<LinkClaims, "id"> & { id?: string },
  secret: string,
): Promise<string> {
  if (!isSlug(claims.campaign)) throw new Error(`Invalid campaign: ${claims.campaign}`);
  if (!isSlug(claims.contributor)) throw new Error(`Invalid contributor: ${claims.contributor}`);
  if (claims.permissions.length === 0) throw new Error("A link needs at least one permission");
  const wire: WireClaims = {
    v: 1,
    c: claims.campaign,
    u: claims.contributor,
    p: [...new Set(claims.permissions)].map((p) => PERMISSION_CODES[p]).sort().join(""),
    g: claims.generation,
    i: claims.id ?? randomId(9),
  };
  if (claims.expiresAt !== undefined) wire.e = claims.expiresAt;
  if (claims.label) wire.n = claims.label.slice(0, 80);
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(wire)));
  const signingInput = `${PREFIX}.${payload}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export type VerifyFailure = "malformed" | "bad-signature" | "expired" | "revoked";

export type VerifyResult = { ok: true; claims: LinkClaims } | { ok: false; reason: VerifyFailure };

export interface VerifyOptions {
  /** Current generation per campaign; campaigns not listed are at generation 1. */
  generations?: Record<string, number>;
  /** Seconds since the epoch; defaults to now. */
  now?: number;
}

export async function verifyLink(token: string, secret: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const [, payload, sig] = parts;

  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    sigBytes as Uint8Array<ArrayBuffer>,
    encoder.encode(`${PREFIX}.${payload}`),
  );
  if (!valid) return { ok: false, reason: "bad-signature" };

  let wire: WireClaims;
  try {
    wire = JSON.parse(decoder.decode(base64UrlDecode(payload)));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (wire.v !== 1 || !isSlug(wire.c) || !isSlug(wire.u) || typeof wire.g !== "number") {
    return { ok: false, reason: "malformed" };
  }

  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (wire.e !== undefined && now >= wire.e) return { ok: false, reason: "expired" };
  const current = opts.generations?.[wire.c] ?? 1;
  if (wire.g < current) return { ok: false, reason: "revoked" };

  const permissions = [...wire.p].map((c) => CODE_TO_PERMISSION[c]).filter(Boolean);
  return {
    ok: true,
    claims: {
      campaign: wire.c,
      contributor: wire.u,
      permissions,
      generation: wire.g,
      expiresAt: wire.e,
      label: wire.n,
      id: wire.i,
    },
  };
}

/** HMAC-signed short-lived state, used for the moderator's OAuth Connect round trip. */
export async function signState(purpose: string, secret: string, ttlSeconds = 600): Promise<string> {
  const body = base64UrlEncode(
    encoder.encode(JSON.stringify({ p: purpose, e: Math.floor(Date.now() / 1000) + ttlSeconds, n: randomId(9) })),
  );
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(`state.${body}`));
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifyState(state: string, purpose: string, secret: string): Promise<boolean> {
  const [body, sig] = state.split(".");
  if (!body || !sig) return false;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlDecode(sig) as Uint8Array<ArrayBuffer>,
      encoder.encode(`state.${body}`),
    );
    if (!ok) return false;
    const parsed = JSON.parse(decoder.decode(base64UrlDecode(body)));
    return parsed.p === purpose && Math.floor(Date.now() / 1000) < parsed.e;
  } catch {
    return false;
  }
}
