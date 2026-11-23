import { test } from "node:test";
import assert from "node:assert/strict";
import { InvalidPathError, isWithin, normalizePath, safeFileName } from "@folderstore/core";

test("normalizePath accepts ordinary relative paths", () => {
  assert.equal(normalizePath("contributors/amy/media/IMG_1.jpg"), "contributors/amy/media/IMG_1.jpg");
  assert.equal(normalizePath("/contributors/amy/"), "contributors/amy");
  assert.equal(normalizePath("", { allowRoot: true }), "");
});

test("normalizePath refuses anything that could escape or hide", () => {
  for (const bad of ["../x", "a/../../b", "a//b", "./a", "a\\b", ".trash/x", "a/.hidden", "a\u0000b", ""]) {
    assert.throws(() => normalizePath(bad), InvalidPathError, bad);
  }
});

test("isWithin matches whole segments only", () => {
  assert.ok(isWithin("contributors/amy/x.jpg", "contributors/amy"));
  assert.ok(!isWithin("contributors/amyb/x.jpg", "contributors/amy"));
});

test("safeFileName strips directories and reserved characters", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("..hidden"), "hidden");
  assert.equal(safeFileName('a<b>c:"d".jpg'), "a_b_c__d_.jpg");
});
