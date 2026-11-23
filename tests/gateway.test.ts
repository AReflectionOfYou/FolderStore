import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "@folderstore/adapter-local";
import { createGateway, loadConfig, type Handler } from "@folderstore/gateway";

const ADMIN = "admin-secret-for-tests";
let root: string;
let gateway: Handler;
const env = { STORAGE_BACKEND: "local", SIGNING_KEY: "s".repeat(40), ADMIN_SECRET: ADMIN, MAX_PROXY_UPLOAD_MB: "1", MAX_UPLOAD_MB: "2" };

function build(extra: Record<string, string> = {}): Handler {
  return createGateway({
    config: loadConfig({ ...env, ...extra }),
    backend: { adapter: new LocalAdapter(root), connect: null },
    log: () => {},
  });
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "folderstore-gw-"));
  gateway = build();
});
after(async () => rm(root, { recursive: true, force: true }));

function call(path: string, init: RequestInit & { token?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
  return gateway(new Request(`https://gw.example${path}`, { ...init, headers }));
}

async function mintLink(campaign: string, contributor: string, permissions: string[]): Promise<string> {
  const res = await call("/api/admin/links", {
    method: "POST",
    token: ADMIN,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ campaign, contributor, permissions }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.url, /^https:\/\/gw\.example\/c#fs=fs1\./);
  return body.token;
}

function put(token: string, path: string, body: string, type = "image/jpeg"): Promise<Response> {
  return call(`/api/files/${path}`, { method: "PUT", token, headers: { "Content-Type": type }, body });
}

test("moderator routes need the admin secret", async () => {
  assert.equal((await call("/api/admin/status")).status, 401);
  assert.equal((await call("/api/admin/status", { token: "wrong-secret-xxxxxxxx" })).status, 401);
  assert.equal((await call("/api/admin/status", { token: ADMIN })).status, 200);
});

test("contributor routes need a valid link", async () => {
  assert.equal((await call("/api/session")).status, 401);
  assert.equal((await call("/api/session", { token: "fs1.bogus.bogus" })).status, 401);
  const token = await mintLink("smith", "amy", ["upload", "list", "read"]);
  const session = await (await call("/api/session", { token })).json();
  assert.equal(session.writePrefix, "contributors/amy");
});

test("a contributor uploads into their own folder, and never overwrites", async () => {
  const token = await mintLink("smith", "amy", ["upload", "list", "read"]);
  const first = await put(token, "contributors/amy/media/IMG_1.jpg", "one");
  assert.equal(first.status, 201);
  assert.equal((await first.json()).path, "contributors/amy/media/IMG_1.jpg");

  const second = await put(token, "contributors/amy/media/IMG_1.jpg", "two");
  assert.equal(second.status, 201);
  const secondPath = (await second.json()).path;
  assert.notEqual(secondPath, "contributors/amy/media/IMG_1.jpg");
  assert.match(secondPath, /^contributors\/amy\/media\/IMG_1\.[a-z0-9]+\.jpg$/);

  const read = await call("/api/files/contributors/amy/media/IMG_1.jpg", { token });
  assert.equal(await read.text(), "one");
  assert.deepEqual((await readdir(join(root, "smith/contributors/amy/media"))).length, 2);
});

test("a contributor cannot write outside their own folder or escape the campaign", async () => {
  const token = await mintLink("smith", "amy", ["upload"]);
  assert.equal((await put(token, "contributors/bob/media/x.jpg", "x")).status, 403);
  assert.equal((await put(token, "derived/index.json", "x", "application/json")).status, 403);
  // The URL parser collapses a literal "..", so this arrives as contributors/bob/... and is refused as such.
  assert.equal((await put(token, "contributors/amy/../bob/x.jpg", "x")).status, 403);
  assert.equal((await put(token, "contributors/amy/%2e%2e/bob/x.jpg", "x")).status, 403);
  // An encoded slash survives URL parsing; the gateway's own path check must catch it.
  assert.equal((await put(token, "contributors/amy/..%2Fbob/x.jpg", "x")).status, 400);
  assert.equal((await put(token, "contributors/amy/..%2F..%2F..%2Fjones/contributors/amy/x.jpg", "x")).status, 400);
});

test("permissions are enforced: an upload-only link cannot list or read others", async () => {
  const family = await mintLink("smith", "bob", ["upload", "list", "read"]);
  await put(family, "contributors/bob/media/B.jpg", "bob");
  const guest = await mintLink("smith", "guests", ["upload"]);
  assert.equal((await call("/api/files?path=", { token: guest })).status, 403);
  assert.equal((await call("/api/files/contributors/bob/media/B.jpg", { token: guest })).status, 403);
  // ...but can read back its own upload.
  await put(guest, "contributors/guests/media/G.jpg", "guest");
  assert.equal((await call("/api/files/contributors/guests/media/G.jpg", { token: guest })).status, 200);
});

test("links are scoped to one campaign", async () => {
  const other = await mintLink("jones", "amy", ["upload", "list", "read"]);
  const list = await (await call("/api/files?path=contributors", { token: other })).json();
  assert.deepEqual(list.entries, []);
  assert.equal((await call("/api/files/contributors/amy/media/IMG_1.jpg", { token: other })).status, 404);
});

test("size and type limits apply, and large files are refused when there is no direct path", async () => {
  const token = await mintLink("smith", "amy", ["upload"]);
  assert.equal((await put(token, "contributors/amy/x.exe", "x", "application/x-msdownload")).status, 415);
  const plan = await call("/api/uploads", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "contributors/amy/media/small.jpg", size: 1000, contentType: "image/jpeg" }),
  });
  assert.equal((await plan.json()).mode, "proxy");
  const big = await call("/api/uploads", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "contributors/amy/media/big.mov", size: 1.5 * 1024 * 1024, contentType: "video/quicktime" }),
  });
  assert.equal(big.status, 413); // local adapter has no direct upload; over the 1 MB proxy limit
  const tooBig = await call("/api/uploads", {
    method: "POST",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: "contributors/amy/media/huge.mov", size: 3 * 1024 * 1024, contentType: "video/quicktime" }),
  });
  assert.equal(tooBig.status, 413);
});

test("raising a campaign's generation revokes its existing links", async () => {
  const token = await mintLink("smith", "amy", ["upload"]);
  gateway = build({ LINK_GENERATIONS: '{"smith": 2}' });
  try {
    assert.equal((await call("/api/session", { token })).status, 403);
  } finally {
    gateway = build();
  }
});

test("moderator delete moves to trash, not oblivion", async () => {
  const token = await mintLink("smith", "carol", ["upload"]);
  await put(token, "contributors/carol/media/C.jpg", "carol");
  const del = await call("/api/admin/files?campaign=smith&path=contributors/carol/media/C.jpg", { method: "DELETE", token: ADMIN });
  assert.equal(del.status, 200);
  const trash = await readdir(join(root, ".trash/smith/contributors/carol/media"));
  assert.equal(trash.length, 1);
});

test("CORS headers are set and preflight succeeds", async () => {
  const res = await gateway(new Request("https://gw.example/api/session", { method: "OPTIONS", headers: { Origin: "https://app.example" } }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});
