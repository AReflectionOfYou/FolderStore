import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalAdapter } from "@folderstore/adapter-local";
import { FolderStoreClient, FolderStoreError, cleanName, sidecarPathFor, timestampedName } from "@folderstore/client";
import { PathExistsError, type StorageAdapter, type UploadTarget } from "@folderstore/core";
import { createGateway, loadConfig, type Handler } from "@folderstore/gateway";

const GW = "https://gw.test";
const STORAGE = "https://storage.test";
const ADMIN = "admin-secret-for-tests";

let root: string;
let gateway: Handler;
let local: LocalAdapter;
let directUploads = 0;

/** A local adapter that also hands out direct-upload URLs on a fake storage host. */
function withDirectUploads(inner: LocalAdapter): StorageAdapter {
  return Object.assign(Object.create(inner), {
    async createUploadTarget(path: string): Promise<UploadTarget> {
      return {
        url: `${STORAGE}/upload?path=${encodeURIComponent(path)}`,
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
    },
  });
}

/** Routes gateway URLs to the handler and fake storage URLs to the local adapter. */
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.origin === STORAGE) {
    const path = url.searchParams.get("path")!;
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    try {
      await local.write(path, bytes);
      directUploads++;
      return new Response("{}", { status: 200 });
    } catch (err) {
      if (err instanceof PathExistsError) return new Response("conflict", { status: 409 });
      throw err;
    }
  }
  return gateway(new Request(url, init));
}) as typeof fetch;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "folderstore-client-"));
  local = new LocalAdapter(root);
  gateway = createGateway({
    // 0.001 MB ≈ 1 KB: anything bigger goes direct.
    config: loadConfig({ SIGNING_KEY: "s".repeat(40), ADMIN_SECRET: ADMIN, MAX_PROXY_UPLOAD_MB: "0.001", MAX_UPLOAD_MB: "1" }),
    backend: { adapter: withDirectUploads(local), connect: null },
    log: () => {},
  });
});
after(async () => rm(root, { recursive: true, force: true }));

async function clientFor(contributor: string, permissions: string[]): Promise<FolderStoreClient> {
  const res = await gateway(
    new Request(`${GW}/api/admin/links`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ campaign: "smith", contributor, permissions }),
    }),
  );
  const { token } = await res.json();
  return new FolderStoreClient({ gatewayUrl: GW, token, fetch: fakeFetch });
}

const small = (text: string, type = "image/jpeg") => new Blob([text], { type });
const big = (fill: number) => new Blob([new Uint8Array(4096).fill(fill)], { type: "video/mp4" });

test("session reports the link's scope", async () => {
  const client = await clientFor("amy", ["upload", "list", "read"]);
  const session = await client.session();
  assert.equal(session.campaign, "smith");
  assert.equal(session.writePrefix, "contributors/amy");
  assert.deepEqual([...session.permissions].sort(), ["list", "read", "upload"]);
});

test("small files go through the gateway; large files go direct", async () => {
  const client = await clientFor("amy", ["upload", "list", "read"]);
  const a = await client.upload(small("tiny"), "media/a.jpg");
  assert.deepEqual(a, { path: "contributors/amy/media/a.jpg", size: 4, mode: "proxy" });
  const before = directUploads;
  const v = await client.upload(big(1), "media/v.mp4");
  assert.deepEqual(v, { path: "contributors/amy/media/v.mp4", size: 4096, mode: "direct" });
  assert.equal(directUploads, before + 1);
  assert.equal(await (await client.read(v.path)).size, 4096);
});

test("collisions never overwrite, on either path", async () => {
  const client = await clientFor("bob", ["upload", "read"]);
  const p1 = await client.upload(small("one"), "media/same.jpg");
  const p2 = await client.upload(small("two"), "media/same.jpg");
  assert.notEqual(p1.path, p2.path);
  assert.equal(await (await client.read(p1.path)).text(), "one");

  const d1 = await client.upload(big(1), "media/clip.mp4");
  const d2 = await client.upload(big(2), "media/clip.mp4");
  assert.equal(d2.mode, "direct");
  assert.notEqual(d1.path, d2.path);
  assert.match(d2.path, /^contributors\/bob\/media\/clip\.[a-z0-9]+\.mp4$/);
  assert.equal(new Uint8Array(await (await client.read(d1.path)).arrayBuffer())[0], 1);
});

test("uploadWithSidecar keeps the sidecar on the photo's final root name", async () => {
  const client = await clientFor("carol", ["upload", "read"]);
  await client.upload(small("first"), "media/IMG_0412.jpg");
  const { file, sidecar } = await client.uploadWithSidecar(small("second"), "media/IMG_0412.jpg", { note: "Aunt Rose" });
  assert.notEqual(file.path, "contributors/carol/media/IMG_0412.jpg");
  assert.equal(sidecar.path, sidecarPathFor(file.path));
  assert.deepEqual(await client.readJson(sidecar.path), { note: "Aunt Rose" });
});

test("listAll walks subfolders", async () => {
  const client = await clientFor("dave", ["upload", "list", "read"]);
  await client.upload(small("x"), "media/2026/one.jpg");
  await client.writeJson("items/one.story.dave.2026-11-22T000000Z.json", { story: "hi" });
  const paths = (await client.listAll("contributors/dave")).map((e) => e.path).sort();
  assert.deepEqual(paths, ["contributors/dave/items/one.story.dave.2026-11-22T000000Z.json", "contributors/dave/media/2026/one.jpg"]);
});

test("gateway refusals surface as FolderStoreError with the gateway's message", async () => {
  const guest = await clientFor("guests", ["upload"]);
  await assert.rejects(guest.list(""), (err: unknown) => err instanceof FolderStoreError && err.status === 403 && /does not allow list/.test(err.message));
  await assert.rejects(guest.upload(small("x", "application/x-msdownload"), "media/x.exe"), (err: unknown) => err instanceof FolderStoreError && err.status === 415);
  await assert.rejects(guest.upload(new Blob([new Uint8Array(2 * 1024 * 1024)], { type: "video/mp4" }), "media/huge.mp4"), (err: unknown) => err instanceof FolderStoreError && err.status === 413);
  const bad = new FolderStoreClient({ gatewayUrl: GW, token: "fs1.bad.bad", fetch: fakeFetch });
  await assert.rejects(bad.session(), (err: unknown) => err instanceof FolderStoreError && err.status === 401);
});

test("mediaUrl falls back to an object URL when storage has no links", async () => {
  const client = await clientFor("erin", ["upload", "read"]);
  const { path } = await client.upload(small("pic"), "media/p.jpg");
  const url = await client.mediaUrl(path);
  assert.match(url, /^blob:/);
  URL.revokeObjectURL(url);
});

test("name helpers", () => {
  assert.equal(sidecarPathFor("media/IMG_0412.jpg"), "media/IMG_0412.json");
  assert.equal(sidecarPathFor("media/v2.0/clip"), "media/v2.0/clip.json");
  assert.equal(cleanName("../My Photo: 1.JPG"), "My Photo_ 1.JPG");
  assert.equal(timestampedName("a.jpg", new Date("2026-11-22T20:11:25.123Z")), "20261122T201125Z_a.jpg");
});
