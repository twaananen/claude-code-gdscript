import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { mkdir, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";

export const DEFAULT_REGISTRY_DIR = path.join(homedir(), ".gdscript-lsp");

export function normalizeProjectRoot(projectRoot) {
  if (!projectRoot) {
    throw new Error("A project root is required.");
  }

  return path.resolve(projectRoot).replace(/[\\/]+$/, "");
}

export function getProjectKey(projectRoot) {
  return createHash("sha256")
    .update(normalizeProjectRoot(projectRoot))
    .digest("hex")
    .slice(0, 12);
}

export function getProjectRecordPaths({
  projectRoot,
  registryDir = DEFAULT_REGISTRY_DIR,
}) {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const projectName = path
    .basename(normalizedRoot)
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  const projectKey = getProjectKey(normalizedRoot);
  const fileName = `${projectName}-${projectKey}.json`;

  return {
    fileName,
    lockPath: path.join(registryDir, "locks", fileName.replace(/\.json$/, ".lock")),
    projectKey,
    projectName,
    recordPath: path.join(registryDir, "projects", fileName),
  };
}

async function ensureProjectDirectories(paths) {
  await mkdir(path.dirname(paths.recordPath), { recursive: true });
  await mkdir(path.dirname(paths.lockPath), { recursive: true });
}

function createProjectRecord(projectRoot, record) {
  const normalizedRoot = normalizeProjectRoot(projectRoot);
  const projectName = path.basename(normalizedRoot);
  const timestamp = new Date().toISOString();

  return {
    ...record,
    projectName: record.projectName || projectName,
    projectRoot: normalizedRoot,
    updatedAt: record.updatedAt || timestamp,
  };
}

export async function readProjectRecord({
  projectRoot,
  registryDir = DEFAULT_REGISTRY_DIR,
}) {
  const paths = getProjectRecordPaths({ projectRoot, registryDir });

  try {
    const content = await readFile(paths.recordPath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function writeProjectRecord({
  projectRoot,
  record,
  registryDir = DEFAULT_REGISTRY_DIR,
}) {
  const paths = getProjectRecordPaths({ projectRoot, registryDir });
  await ensureProjectDirectories(paths);

  const payload = createProjectRecord(projectRoot, record);
  const temporaryPath = `${paths.recordPath}.${process.pid}.${Date.now()}.tmp`;

  await writeFile(temporaryPath, JSON.stringify(payload, null, 2));
  await rename(temporaryPath, paths.recordPath);

  return payload;
}

export async function deleteProjectRecord({
  projectRoot,
  registryDir = DEFAULT_REGISTRY_DIR,
}) {
  const paths = getProjectRecordPaths({ projectRoot, registryDir });
  await rm(paths.recordPath, { force: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "EPERM") {
      return true;
    }

    return false;
  }
}

async function clearIfStaleLock(lockPath) {
  try {
    const content = await readFile(lockPath, "utf8");
    const lock = JSON.parse(content);

    if (!isProcessAlive(lock.pid)) {
      await unlink(lockPath);
      return true;
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return true;
    }

    await unlink(lockPath).catch(() => {});
    return true;
  }

  return false;
}

export async function withProjectLock({
  projectRoot,
  registryDir = DEFAULT_REGISTRY_DIR,
  retryDelayMs = 100,
  task,
  timeoutMs = 10_000,
}) {
  const paths = getProjectRecordPaths({ projectRoot, registryDir });
  await ensureProjectDirectories(paths);

  const deadline = Date.now() + timeoutMs;
  let handle;

  while (true) {
    try {
      handle = await open(paths.lockPath, "wx");
      await handle.writeFile(
        JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid })
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      if (await clearIfStaleLock(paths.lockPath)) {
        continue;
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for project lock for ${normalizeProjectRoot(projectRoot)}`
        );
      }

      await sleep(retryDelayMs);
    }
  }

  try {
    return await task();
  } finally {
    await handle?.close();

    try {
      await unlink(paths.lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}
