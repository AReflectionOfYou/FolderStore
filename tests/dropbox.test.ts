import { test } from "node:test";
import assert from "node:assert/strict";
import { DropboxAdapter, headerJson } from "@folderstore/adapter-dropbox";
import { NotFoundError, PathExistsError } from "@folderstore/core";

interface Call { url: string; headers: Record<string, string>; body: string }

function mockDropbox(responder: (call: Call, n: number) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : String(init?.body ?? "");
    const call = { url: String(input), headers, body };
    calls.push(call);
    return responder(call, calls.length);
  }) as typeof fetch;
  let tokenCalls = 0;
  const tokens = { getAccessToken: async (force = false) => (force || tokenCalls++ === 0 ? `tok${tokenCalls}` : `tok${tokenCalls}`) };
  return { calls, adapter: new DropboxAdapter({ tokens, root: "campaigns", fetch: fetchImpl }) };
}

const conflict = () => new Response(JSON.stringify({ error_summary: "path/conflict/file/.." }), { status: 409 });
const notFound = () => new Response(JSON.stringify({ error_summary: "path/not_found/." }), { status: 409 });

test("write uses mode add with autorename off, under the configured root", async () => {
  const { calls, adapter } = mockDropbox(() =>
    // Real files/upload responses carry no ".tag" field.
    Response.json({ name: "a.jpg", path_display: "/campaigns/smith/a.jpg", size: 3, content_hash: "h", server_modified: "2026-11-23T02:16:32Z" }),
  );
  const entry = await adapter.write("smith/a.jpg", new TextEncoder().encode("abc"));
  assert.equal(entry.type, "file");
  assert.equal(entry.size, 3);
  const arg = JSON.parse(calls[0].headers["dropbox-api-arg"]);
  assert.deepEqual(arg, { path: "/campaigns/smith/a.jpg", mode: "add", autorename: false, mute: true });
  assert.equal(entry.path, "smith/a.jpg");
});

test("a Dropbox conflict becomes PathExistsError and not_found becomes NotFoundError", async () => {
  const a = mockDropbox(conflict);
  await assert.rejects(a.adapter.write("smith/a.jpg", new Uint8Array([1])), PathExistsError);
  const b = mockDropbox(notFound);
  await assert.rejects(b.adapter.read("smith/missing.jpg"), NotFoundError);
  assert.deepEqual(await b.adapter.list("smith/nothing"), []);
});

test("a 401 triggers one token refresh and a retry", async () => {
  const { calls, adapter } = mockDropbox((_c, n) =>
    n === 1 ? new Response("expired", { status: 401 }) : Response.json({ link: "https://dl.example/x" }),
  );
  assert.equal(await adapter.getLink("smith/a.jpg"), "https://dl.example/x");
  assert.equal(calls.length, 2);
});

test("direct upload targets also refuse to overwrite", async () => {
  const { calls, adapter } = mockDropbox(() => Response.json({ link: "https://content.dropboxapi.com/apitul/1/abc" }));
  const target = await adapter.createUploadTarget("smith/v.mov", { size: 50_000_000, contentType: "video/quicktime" });
  assert.equal(target?.url, "https://content.dropboxapi.com/apitul/1/abc");
  const body = JSON.parse(calls[0].body);
  assert.deepEqual(body.commit_info, { path: "/campaigns/smith/v.mov", mode: "add", autorename: false, mute: true });
});

test("listing hides the trash and maps paths back to relative form", async () => {
  const { adapter } = mockDropbox(() =>
    Response.json({
      entries: [
        { ".tag": "folder", name: ".trash", path_display: "/campaigns/.trash" },
        { ".tag": "folder", name: "smith", path_display: "/Campaigns/smith" },
      ],
      cursor: "c",
      has_more: false,
    }),
  );
  assert.deepEqual((await adapter.list("")).map((e) => e.path), ["smith"]);
});

test("Dropbox-API-Arg is ASCII-safe for non-English names", () => {
  assert.equal(headerJson({ path: "/Zoë.jpg" }), '{"path":"/Zo\\u00eb.jpg"}');
});
