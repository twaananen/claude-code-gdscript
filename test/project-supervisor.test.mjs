import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeProjectRecord } from "../bridge/project-registry.mjs";
import {
  resolveProjectBackend,
  spawnGodotBackend,
} from "../bridge/project-supervisor.mjs";

test("resolveProjectBackend reuses a healthy registered backend", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-supervisor-"));

  try {
    const projectRoot = "/Users/test/reuse-project";
    await writeProjectRecord({
      projectRoot,
      registryDir,
      record: {
        host: "127.0.0.1",
        mode: "headless",
        pid: 1234,
        port: 6100,
        projectRoot,
        startedAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
      },
    });

    const backend = await resolveProjectBackend({
      healthCheck: async () => true,
      projectRoot,
      registryDir,
    });

    assert.equal(backend.port, 6100);
    assert.equal(backend.source, "registry");
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("resolveProjectBackend launches a new backend when registry is stale", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-launch-"));

  try {
    const projectRoot = "/Users/test/new-project";
    const calls = [];

    const backend = await resolveProjectBackend({
      findAvailablePort: async () => 6200,
      healthCheck: async () => false,
      projectRoot,
      registryDir,
      spawnBackend: async ({ port, projectRoot: root }) => {
        calls.push({ port, projectRoot: root });
        return { pid: 4444 };
      },
      waitForBackend: async () => {},
    });

    assert.equal(backend.port, 6200);
    assert.equal(backend.pid, 4444);
    assert.equal(backend.source, "launched");
    assert.deepEqual(calls, [{ port: 6200, projectRoot }]);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("resolveProjectBackend uses loopback host in auto mode", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-host-"));
  const calls = [];

  try {
    const backend = await resolveProjectBackend({
      findAvailablePort: async ({ host }) => {
        calls.push({ kind: "find", host });
        return 6300;
      },
      healthCheck: async ({ host, port }) => {
        calls.push({ kind: "health", host, port });
        return false;
      },
      host: "10.0.0.25",
      projectRoot: "/Users/test/loopback-project",
      registryDir,
      spawnBackend: async ({ host, port }) => {
        calls.push({ kind: "spawn", host, port });
        return { pid: 7777 };
      },
      waitForBackend: async ({ host, port }) => {
        calls.push({ kind: "wait", host, port });
      },
    });

    assert.equal(backend.host, "127.0.0.1");
    assert.deepEqual(
      calls.filter((call) => call.kind !== "health"),
      [
        { kind: "find", host: "127.0.0.1" },
        { kind: "spawn", host: "127.0.0.1", port: 6300 },
        { kind: "wait", host: "127.0.0.1", port: 6300 },
      ]
    );
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("resolveProjectBackend does not relaunch when a stale check races with a fresh record", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-race-"));
  const projectRoot = "/Users/test/race-project";
  let launchCount = 0;
  let staleChecks = 0;
  let releaseSecondCheck;
  const secondCheckReleased = new Promise((resolve) => {
    releaseSecondCheck = resolve;
  });

  try {
    await writeProjectRecord({
      projectRoot,
      registryDir,
      record: {
        host: "127.0.0.1",
        mode: "headless",
        pid: 1111,
        port: 6100,
        projectRoot,
        startedAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
      },
    });

    const healthCheck = async ({ port }) => {
      if (port === 6100) {
        staleChecks += 1;
        if (staleChecks === 2) {
          await secondCheckReleased;
        }
        return false;
      }

      return port === 6200 && launchCount > 0;
    };

    const spawnBackend = async () => {
      launchCount += 1;
      releaseSecondCheck();
      return { pid: 2222 };
    };

    const [first, second] = await Promise.all([
      resolveProjectBackend({
        findAvailablePort: async () => 6200,
        healthCheck,
        projectRoot,
        registryDir,
        spawnBackend,
        waitForBackend: async () => {},
      }),
      resolveProjectBackend({
        findAvailablePort: async () => 6200,
        healthCheck,
        projectRoot,
        registryDir,
        spawnBackend,
        waitForBackend: async () => {},
      }),
    ]);

    assert.equal(launchCount, 1);
    assert.equal(first.port, 6200);
    assert.equal(second.port, 6200);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("spawnGodotBackend rejects immediately when the executable is missing", async () => {
  await assert.rejects(
    spawnGodotBackend({
      editorPath: "/definitely-missing/godot",
      port: 6005,
      projectRoot: "/Users/test/missing-executable",
    })
  );
});

test("resolveProjectBackend terminates a launched backend when startup verification fails", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-timeout-"));
  let terminatedPid = null;

  try {
    await assert.rejects(
      resolveProjectBackend({
        findAvailablePort: async () => 6400,
        healthCheck: async () => false,
        projectRoot: "/Users/test/timeout-project",
        registryDir,
        spawnBackend: async () => ({ pid: 3333 }),
        terminateProcess: async (pid) => {
          terminatedPid = pid;
        },
        waitForBackend: async () => {
          throw new Error("backend startup timed out");
        },
      })
    );

    assert.equal(terminatedPid, 3333);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("resolveProjectBackend terminates an unreachable recorded backend before relaunching", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-unhealthy-"));
  const projectRoot = "/Users/test/unhealthy-project";
  const terminated = [];

  try {
    await writeProjectRecord({
      projectRoot,
      registryDir,
      record: {
        host: "127.0.0.1",
        mode: "headless",
        pid: 12345,
        port: 6009,
        projectRoot,
        startedAt: "2026-03-07T12:00:00.000Z",
        updatedAt: "2026-03-07T12:00:00.000Z",
      },
    });

    const backend = await resolveProjectBackend({
      findAvailablePort: async () => 6401,
      healthCheck: async ({ port }) => port === 6401,
      projectRoot,
      registryDir,
      spawnBackend: async () => ({ pid: 54321 }),
      terminateProcess: async (pid) => {
        terminated.push(pid);
      },
      waitForBackend: async () => {},
    });

    assert.equal(backend.port, 6401);
    assert.deepEqual(terminated, [12345]);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});
