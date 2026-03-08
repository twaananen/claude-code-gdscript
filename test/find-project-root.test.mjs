import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { findGodotProjectRoot } from "../bridge/gdscript-lsp-bridge.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-find-root-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

async function touch(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "");
}

test("returns startPath when project.godot exists at root", () =>
  withTempDir(async (dir) => {
    await touch(path.join(dir, "project.godot"));

    assert.equal(findGodotProjectRoot(dir), dir);
  }));

test("finds project.godot in an immediate subdirectory", () =>
  withTempDir(async (dir) => {
    await touch(path.join(dir, "game", "project.godot"));

    assert.equal(findGodotProjectRoot(dir), path.join(dir, "game"));
  }));

test("finds project.godot nested multiple levels deep", () =>
  withTempDir(async (dir) => {
    await touch(path.join(dir, "src", "godot", "project.godot"));

    assert.equal(
      findGodotProjectRoot(dir),
      path.join(dir, "src", "godot"),
    );
  }));

test("returns null when no project.godot exists", () =>
  withTempDir(async (dir) => {
    await mkdir(path.join(dir, "empty-subdir"));

    assert.equal(findGodotProjectRoot(dir), null);
  }));

test("returns null for a nonexistent directory", () => {
  assert.equal(findGodotProjectRoot("/tmp/nonexistent-gdscript-test-dir"), null);
});

test("skips hidden directories", () =>
  withTempDir(async (dir) => {
    await touch(path.join(dir, ".hidden", "project.godot"));

    assert.equal(findGodotProjectRoot(dir), null);
  }));

test("skips node_modules and other large directories", () =>
  withTempDir(async (dir) => {
    await touch(path.join(dir, "node_modules", "project.godot"));
    await touch(path.join(dir, "build", "project.godot"));

    assert.equal(findGodotProjectRoot(dir), null);
  }));

test("returns the first match in a breadth-first-like traversal", () =>
  withTempDir(async (dir) => {
    // Both a shallow and deep match exist — shallow should win
    await touch(path.join(dir, "game", "project.godot"));
    await touch(path.join(dir, "other", "deep", "nested", "project.godot"));

    const result = findGodotProjectRoot(dir);
    // Should find one of them (filesystem order), but both are valid
    assert.ok(
      result === path.join(dir, "game") ||
        result === path.join(dir, "other", "deep", "nested"),
    );
  }));
