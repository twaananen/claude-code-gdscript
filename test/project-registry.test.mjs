import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  getProjectRecordPaths,
  readProjectRecord,
  withProjectLock,
  writeProjectRecord,
} from "../bridge/project-registry.mjs";

test("writeProjectRecord persists records by normalized project path", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-registry-"));

  try {
    const record = {
      host: "127.0.0.1",
      mode: "headless",
      port: 6012,
      projectRoot: "/Users/test/example-project",
      startedAt: "2026-03-07T12:00:00.000Z",
      updatedAt: "2026-03-07T12:00:00.000Z",
    };

    await writeProjectRecord({ projectRoot: record.projectRoot, record, registryDir });
    const loaded = await readProjectRecord({
      projectRoot: "/Users/test/example-project/",
      registryDir,
    });

    assert.equal(loaded.projectName, "example-project");
    assert.equal(loaded.port, 6012);
    assert.match(getProjectRecordPaths({ projectRoot: record.projectRoot, registryDir }).recordPath, /example-project/);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("withProjectLock serializes access per project", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-lock-"));
  let activeTasks = 0;
  let maxActiveTasks = 0;

  try {
    const projectRoot = "/Users/test/locked-project";
    const first = withProjectLock({
      projectRoot,
      registryDir,
      retryDelayMs: 5,
      timeoutMs: 500,
      async task() {
        activeTasks += 1;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeTasks -= 1;
      },
    });

    const second = withProjectLock({
      projectRoot,
      registryDir,
      retryDelayMs: 5,
      timeoutMs: 500,
      async task() {
        activeTasks += 1;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        activeTasks -= 1;
      },
    });

    await Promise.all([first, second]);
    assert.equal(maxActiveTasks, 1);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("withProjectLock recovers from a stale lock file", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-stale-lock-"));

  try {
    const projectRoot = "/Users/test/stale-lock-project";
    const { lockPath } = getProjectRecordPaths({ projectRoot, registryDir });
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ createdAt: new Date().toISOString(), pid: 999999 })
    );

    let ranTask = false;
    await withProjectLock({
      projectRoot,
      registryDir,
      retryDelayMs: 5,
      timeoutMs: 100,
      async task() {
        ranTask = true;
      },
    });

    assert.equal(ranTask, true);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});
