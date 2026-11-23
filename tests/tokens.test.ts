import { test } from "node:test";
import assert from "node:assert/strict";
import { signLink, verifyLink } from "@folderstore/core";

const KEY = "k".repeat(40);
const base = { campaign: "smith-family", contributor: "aunt-rose", permissions: ["upload", "list"] as const, generation: 1 };

test("a signed link verifies and round-trips its claims", async () => {
  const token = await signLink({ ...base, permissions: [...base.permissions], label: "Aunt Rose" }, KEY);
  const result = await verifyLink(token, KEY);
  assert.ok(result.ok);
  assert.equal(result.claims.campaign, "smith-family");
  assert.equal(result.claims.contributor, "aunt-rose");
  assert.deepEqual([...result.claims.permissions].sort(), ["list", "upload"]);
  assert.equal(result.claims.label, "Aunt Rose");
});

test("a tampered payload or a different key is rejected", async () => {
  const token = await signLink({ ...base, permissions: ["upload"] }, KEY);
  const [prefix, payload, sig] = token.split(".");
  const forged = JSON.parse(Buffer.from(payload, "base64url").toString());
  forged.p = "lru";
  const forgedToken = `${prefix}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
  assert.deepEqual(await verifyLink(forgedToken, KEY), { ok: false, reason: "bad-signature" });
  assert.deepEqual(await verifyLink(token, "x".repeat(40)), { ok: false, reason: "bad-signature" });
  assert.deepEqual(await verifyLink("garbage", KEY), { ok: false, reason: "malformed" });
});

test("expiry and per-campaign generation revoke links", async () => {
  const now = Math.floor(Date.now() / 1000);
  const expiring = await signLink({ ...base, permissions: ["upload"], expiresAt: now + 60 }, KEY);
  assert.ok((await verifyLink(expiring, KEY, { now })).ok);
  assert.deepEqual(await verifyLink(expiring, KEY, { now: now + 61 }), { ok: false, reason: "expired" });

  const gen1 = await signLink({ ...base, permissions: ["upload"] }, KEY);
  assert.deepEqual(await verifyLink(gen1, KEY, { generations: { "smith-family": 2 } }), { ok: false, reason: "revoked" });
  assert.ok((await verifyLink(gen1, KEY, { generations: { "other-campaign": 5 } })).ok);
});
