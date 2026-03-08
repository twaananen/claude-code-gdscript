#!/usr/bin/env node

import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  LspParser,
  encodeLspMessage,
  extractProjectContextFromMessage,
} from "./lsp-protocol.mjs";
import { normalizeProjectRoot } from "./project-registry.mjs";
import { resolveProjectBackend } from "./project-supervisor.mjs";

const CONFIG = {
  attachHost: process.env.GODOT_LSP_HOST || "127.0.0.1",
  attachPort: Number.parseInt(process.env.GODOT_LSP_PORT || "6005", 10),
  connectTimeoutMs: Number.parseInt(
    process.env.GODOT_LSP_CONNECT_TIMEOUT_MS || "1000",
    10
  ),
  initialMaxAttempts: Number.parseInt(
    process.env.GODOT_LSP_INITIAL_MAX_ATTEMPTS || "5",
    10
  ),
  mode: process.env.GODOT_LSP_MODE || "auto",
  projectRootOverride: process.env.GODOT_PROJECT_ROOT || null,
  registryDir: process.env.GODOT_LSP_REGISTRY_DIR || undefined,
  retryDelayMs: Number.parseInt(
    process.env.GODOT_LSP_RETRY_DELAY_MS || "500",
    10
  ),
};

const state = {
  backend: null,
  connectPromise: null,
  currentSocket: null,
  pendingBodies: [],
  projectContext: CONFIG.projectRootOverride
    ? {
        clientName: "env-override",
        projectName: path.basename(normalizeProjectRoot(CONFIG.projectRootOverride)),
        projectRoot: normalizeProjectRoot(CONFIG.projectRootOverride),
      }
    : null,
  shuttingDown: false,
};

function log(event, details = {}) {
  process.stderr.write(
    `[gdscript-lsp-bridge] ${JSON.stringify({
      event,
      timestamp: new Date().toISOString(),
      ...details,
    })}\n`
  );
}

function describeError(error) {
  return {
    code: error?.code,
    message: error?.message || String(error),
    name: error?.name,
  };
}

/**
 * Finds the actual Godot project root by searching for project.godot.
 * Claude Code sends the workspace CWD as rootUri, but the Godot project
 * may be in a subdirectory (e.g., game/).
 */
function findGodotProjectRoot(startPath) {
  if (existsSync(path.join(startPath, "project.godot"))) {
    return startPath;
  }

  try {
    const entries = readdirSync(startPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        const subPath = path.join(startPath, entry.name);
        if (existsSync(path.join(subPath, "project.godot"))) {
          return subPath;
        }
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return null;
}

function parseJsonMessage(body) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return null;
  }
}

function connectSocket({ host, port, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });

    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("timeout", onTimeout);
    };

    const onConnect = () => {
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onTimeout = () => {
      onError(new Error(`Timed out connecting to ${host}:${port}`));
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("timeout", onTimeout);
  });
}

async function connectSocketWithRetry({ host, port }) {
  let attempt = 1;

  while (attempt <= CONFIG.initialMaxAttempts) {
    try {
      return await connectSocket({
        host,
        port,
        timeoutMs: CONFIG.connectTimeoutMs,
      });
    } catch (error) {
      if (attempt >= CONFIG.initialMaxAttempts) {
        throw new Error(
          `Failed to connect to Godot LSP at ${host}:${port} after ${CONFIG.initialMaxAttempts} attempts: ${error.message}`
        );
      }

      const delay = CONFIG.retryDelayMs * 2 ** (attempt - 1);
      log("connect_retry", {
        attempt,
        delayMs: delay,
        host,
        port,
        ...describeError(error),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }

  throw new Error(`Failed to connect to Godot LSP at ${host}:${port}`);
}

function flushPendingBodies() {
  if (!state.currentSocket?.writable) {
    return;
  }

  while (state.pendingBodies.length > 0) {
    const body = state.pendingBodies.shift();
    state.currentSocket.write(encodeLspMessage(body));
  }
}

function attachSocket(socket, backend) {
  const tcpParser = new LspParser((body) => {
    process.stdout.write(encodeLspMessage(body));
  });

  socket.on("data", (chunk) => tcpParser.feed(chunk));
  socket.on("close", (hadError) => {
    if (socket !== state.currentSocket) {
      return;
    }

    state.currentSocket = null;
    log("socket_closed", {
      hadError,
      host: backend.host,
      port: backend.port,
      projectRoot: backend.projectRoot,
    });

    // Force a clean restart so Claude replays initialize and document state.
    process.exit(1);
  });
  socket.on("error", (error) => {
    if (socket !== state.currentSocket) {
      return;
    }

    log("socket_error", {
      host: backend.host,
      port: backend.port,
      projectRoot: backend.projectRoot,
      ...describeError(error),
    });
  });
}

async function ensureConnected() {
  if (state.shuttingDown || state.currentSocket || state.connectPromise) {
    return;
  }

  if (CONFIG.mode !== "attach" && !state.projectContext) {
    return;
  }

  state.connectPromise = (async () => {
    try {
      const backend = await resolveProjectBackend({
        connectTimeoutMs: CONFIG.connectTimeoutMs,
        host: CONFIG.attachHost,
        mode: CONFIG.mode,
        port: CONFIG.attachPort,
        projectRoot: state.projectContext?.projectRoot,
        registryDir: CONFIG.registryDir,
      });
      const socket = await connectSocketWithRetry({
        host: backend.host,
        port: backend.port,
      });

      state.backend = backend;
      state.currentSocket = socket;
      attachSocket(socket, backend);
      flushPendingBodies();

      log("connected", {
        host: backend.host,
        mode: backend.mode,
        port: backend.port,
        projectRoot: backend.projectRoot,
        source: backend.source,
      });
    } catch (error) {
      log("connect_failed", {
        mode: CONFIG.mode,
        projectRoot: state.projectContext?.projectRoot || null,
        ...describeError(error),
      });

      log("connect_help", {
        message:
          CONFIG.mode === "attach"
            ? "Run Godot for this project and point GODOT_LSP_PORT at the matching editor instance."
            : "Could not find Godot. Checked: GODOT_EDITOR_PATH env, PATH, /Applications/Godot.app, and common install locations. Set GODOT_EDITOR_PATH to your Godot binary, or switch to GODOT_LSP_MODE=attach.",
      });
      process.exit(1);
    }
  })().finally(() => {
    state.connectPromise = null;
  });

  return state.connectPromise;
}

function shutdown() {
  state.shuttingDown = true;

  state.currentSocket?.destroy();
  process.exit(0);
}

async function main() {
  log("startup", {
    attachHost: CONFIG.attachHost,
    attachPort: CONFIG.attachPort,
    mode: CONFIG.mode,
    projectRootOverride: state.projectContext?.projectRoot || null,
    registryDir: CONFIG.registryDir || "default",
  });

  const stdinParser = new LspParser((body) => {
    const message = parseJsonMessage(body);
    const projectContext = extractProjectContextFromMessage(body);
    if (projectContext && !state.projectContext) {
      const godotRoot = findGodotProjectRoot(projectContext.projectRoot);
      if (godotRoot && godotRoot !== projectContext.projectRoot) {
        log("godot_project_root_discovered", {
          originalRoot: projectContext.projectRoot,
          godotRoot,
        });
        projectContext.projectRoot = godotRoot;
        projectContext.projectName = path.basename(godotRoot);
      }
      state.projectContext = projectContext;
      log("project_context_resolved", projectContext);
    }

    if (
      CONFIG.mode !== "attach" &&
      !state.projectContext &&
      message?.method === "initialize"
    ) {
      log("initialize_missing_project_root", {
        message:
          "Set GODOT_PROJECT_ROOT or make sure the client sends rootUri, rootPath, or workspaceFolders.",
      });
      process.exit(1);
    }

    if (state.currentSocket?.writable && !state.connectPromise) {
      state.currentSocket.write(encodeLspMessage(body));
      return;
    }

    state.pendingBodies.push(Buffer.from(body));
    void ensureConnected();
  });

  process.stdin.on("data", (chunk) => stdinParser.feed(chunk));
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  if (CONFIG.mode === "attach" || state.projectContext) {
    await ensureConnected();
  }
}

main();
