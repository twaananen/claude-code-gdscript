import { spawn, execFileSync } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import net from "node:net";
import { homedir, platform } from "node:os";
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

async function fileExists(filePath) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function whichSync(command) {
  try {
    const cmd = platform() === "win32" ? "where" : "which";
    return execFileSync(cmd, [command], { encoding: "utf8", timeout: 3000 })
      .split("\n")[0]
      .trim();
  } catch {
    return null;
  }
}

async function findMacOSGodotApps() {
  const appDirs = ["/Applications", path.join(homedir(), "Applications")];
  const results = [];

  for (const dir of appDirs) {
    try {
      const entries = await readdir(dir);
      for (const entry of entries) {
        if (/^Godot/i.test(entry) && entry.endsWith(".app")) {
          results.push(path.join(dir, entry, "Contents", "MacOS", "Godot"));
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable
    }
  }

  return results;
}

function getWellKnownPaths() {
  const os = platform();

  if (os === "darwin") {
    return [
      "/Applications/Godot.app/Contents/MacOS/Godot",
      path.join(homedir(), "Applications/Godot.app/Contents/MacOS/Godot"),
      "/opt/homebrew/bin/godot",
      "/usr/local/bin/godot",
    ];
  }

  if (os === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const localAppData =
      process.env.LOCALAPPDATA ||
      path.join(homedir(), "AppData", "Local");
    const scoopDir = path.join(homedir(), "scoop", "shims");

    return [
      path.join(programFiles, "Godot", "Godot.exe"),
      path.join(programFilesX86, "Godot", "Godot.exe"),
      path.join(localAppData, "Godot", "Godot.exe"),
      path.join(scoopDir, "godot.exe"),
    ];
  }

  // Linux
  return [
    "/usr/bin/godot",
    "/usr/local/bin/godot",
    "/snap/bin/godot",
    path.join(homedir(), ".local", "bin", "godot"),
  ];
}

/**
 * Resolves the Godot editor binary path using a cascade of strategies:
 * 1. GODOT_EDITOR_PATH environment variable (explicit override)
 * 2. `godot` on PATH (standard install or user symlink)
 * 3. Well-known platform-specific locations
 * 4. Dynamic macOS .app bundle discovery (catches versioned installs like "Godot 4.6.app")
 */
export async function resolveGodotEditorPath() {
  // 1. Explicit env var — trust it without checking
  const envPath = process.env.GODOT_EDITOR_PATH;
  if (envPath) {
    return envPath;
  }

  // 2. On PATH
  const onPath = whichSync("godot");
  if (onPath) {
    return onPath;
  }

  // 3. Well-known locations
  for (const candidate of getWellKnownPaths()) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  // 4. macOS: scan for any Godot*.app bundle
  if (platform() === "darwin") {
    const appBinaries = await findMacOSGodotApps();
    for (const candidate of appBinaries) {
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }

  // Fall back to bare "godot" and let spawn() produce the ENOENT error
  return "godot";
}

export async function spawnGodotBackend({
  editorPath,
  port,
  projectRoot,
}) {
  const resolvedPath = editorPath || (await resolveGodotEditorPath());
  return new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--editor",
      "--path",
      projectRoot,
      "--lsp-port",
      String(port),
    ];
    const child = spawn(resolvedPath, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      child.removeListener("error", reject);

      resolve({
        args,
        command: resolvedPath,
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
