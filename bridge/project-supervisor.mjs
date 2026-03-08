import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

import {
  deleteProjectRecord,
  readProjectRecord,
  withProjectLock,
  writeProjectRecord,
} from "./project-registry.mjs";

const DEFAULT_CONNECT_TIMEOUT_MS = 1_000;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function connectToSocket({ host, port, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      cleanup();
      resolve(true);
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error(`Timed out connecting to ${host}:${port}`));
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

export async function tcpHealthCheck({ host, port, timeoutMs }) {
  try {
    await connectToSocket({ host, port, timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function findAvailablePort({ host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      server.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

export async function spawnGodotBackend({
  editorPath = process.env.GODOT_EDITOR_PATH || "godot",
  port,
  projectRoot,
}) {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--editor",
      "--path",
      projectRoot,
      "--lsp-port",
      String(port),
    ];
    const child = spawn(editorPath, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      child.removeListener("error", reject);

      resolve({
        args,
        command: editorPath,
        pid: child.pid,
      });
    });
  });
}

export async function waitForBackend({
  healthCheck = tcpHealthCheck,
  host,
  port,
  retryDelayMs = 250,
  timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await healthCheck({ host, port, timeoutMs: DEFAULT_CONNECT_TIMEOUT_MS })) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }

  throw new Error(`Timed out waiting for Godot LSP backend on ${host}:${port}`);
}

export async function terminateProcess(pid) {
  if (!pid) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}

async function readHealthyRecord({
  connectTimeoutMs,
  deleteStale = true,
  healthCheck,
  projectRoot,
  registryDir,
}) {
  const record = await readProjectRecord({ projectRoot, registryDir });
  if (!record) {
    return null;
  }

  const healthy = await healthCheck({
    host: record.host,
    port: record.port,
    timeoutMs: connectTimeoutMs,
  });
  if (healthy) {
    return record;
  }

  if (deleteStale) {
    await deleteProjectRecord({ projectRoot, registryDir });
  }
  return null;
}

export async function resolveProjectBackend({
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  findAvailablePort: findPort = findAvailablePort,
  healthCheck = tcpHealthCheck,
  host = process.env.GODOT_LSP_HOST || "127.0.0.1",
  mode = process.env.GODOT_LSP_MODE || "auto",
  port = Number.parseInt(process.env.GODOT_LSP_PORT || "6005", 10),
  projectRoot,
  registryDir,
  spawnBackend = spawnGodotBackend,
  terminateProcess: terminateProcessImpl = terminateProcess,
  waitForBackend: waitForBackendImpl = waitForBackend,
}) {
  if (!projectRoot && mode !== "attach") {
    throw new Error("Cannot resolve a project backend before initialize provides a project root.");
  }

  if (mode === "attach") {
    return {
      host,
      mode,
      port,
      projectName: projectRoot ? path.basename(projectRoot) : "unknown-project",
      projectRoot: projectRoot || null,
      source: "configured",
    };
  }

  const backendHost = "127.0.0.1";

  const existingRecord = await readHealthyRecord({
    connectTimeoutMs,
    deleteStale: false,
    healthCheck,
    projectRoot,
    registryDir,
  });
  if (existingRecord) {
    return { ...existingRecord, source: "registry" };
  }

  return withProjectLock({
    projectRoot,
    registryDir,
    timeoutMs: DEFAULT_WAIT_TIMEOUT_MS + 5_000,
    async task() {
      const healthyRecord = await readHealthyRecord({
        connectTimeoutMs,
        deleteStale: true,
        healthCheck,
        projectRoot,
        registryDir,
      });
      if (healthyRecord) {
        return { ...healthyRecord, source: "registry" };
      }

      const resolvedHost = backendHost;
      const resolvedPort = await findPort({ host: resolvedHost });
      const launch = await spawnBackend({
        host: resolvedHost,
        port: resolvedPort,
        projectRoot,
      });

      try {
        await waitForBackendImpl({
          healthCheck,
          host: resolvedHost,
          port: resolvedPort,
        });
      } catch (error) {
        await terminateProcessImpl(launch.pid);
        throw error;
      }

      const record = await writeProjectRecord({
        projectRoot,
        registryDir,
        record: {
          host: resolvedHost,
          mode: "headless",
          pid: launch.pid,
          port: resolvedPort,
          projectRoot,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      return {
        ...record,
        command: launch.command,
        args: launch.args,
        source: "launched",
      };
    },
  });
}
