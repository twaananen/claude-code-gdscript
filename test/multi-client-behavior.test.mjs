import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveProjectBackend } from "../bridge/project-supervisor.mjs";

test("concurrent clients for one project reuse a single launched backend", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-clients-"));
  let launched = false;
  let launchCount = 0;

  try {
    const projectRoot = "/Users/test/shared-project";
    const healthCheck = async ({ port }) => launched && port === 6500;

    const backends = await Promise.all([
      resolveProjectBackend({
        findAvailablePort: async () => 6500,
        healthCheck,
        projectRoot,
        registryDir,
        spawnBackend: async () => {
          launchCount += 1;
          launched = true;
          return { pid: 9001 };
        },
        waitForBackend: async () => {},
      }),
      resolveProjectBackend({
        findAvailablePort: async () => 6500,
        healthCheck,
        projectRoot,
        registryDir,
        spawnBackend: async () => {
          launchCount += 1;
          launched = true;
          return { pid: 9002 };
        },
        waitForBackend: async () => {},
      }),
    ]);

    assert.equal(launchCount, 1);
    assert.equal(backends[0].port, 6500);
    assert.equal(backends[1].port, 6500);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("different projects resolve to different backends", async () => {
  const registryDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-projects-"));
  const launches = [];

  try {
    const healthCheck = async () => false;
    const findAvailablePort = async ({ host }) =>
      launches.length === 0 ? 6600 : 6601;

    const first = await resolveProjectBackend({
      findAvailablePort,
      healthCheck,
      projectRoot: "/Users/test/project-one",
      registryDir,
      spawnBackend: async ({ port, projectRoot }) => {
        launches.push({ port, projectRoot });
        return { pid: 8000 + launches.length };
      },
      waitForBackend: async () => {},
    });

    const second = await resolveProjectBackend({
      findAvailablePort,
      healthCheck,
      projectRoot: "/Users/test/project-two",
      registryDir,
      spawnBackend: async ({ port, projectRoot }) => {
        launches.push({ port, projectRoot });
        return { pid: 8000 + launches.length };
      },
      waitForBackend: async () => {},
    });

    assert.equal(first.port, 6600);
    assert.equal(second.port, 6601);
    assert.notEqual(first.projectRoot, second.projectRoot);
  } finally {
    await rm(registryDir, { force: true, recursive: true });
  }
});
