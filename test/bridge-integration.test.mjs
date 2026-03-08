import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LspParser, encodeLspMessage } from "../bridge/lsp-protocol.mjs";
import { readProjectRecord, writeProjectRecord } from "../bridge/project-registry.mjs";

const BRIDGE_PATH = fileURLToPath(
  new URL("../bridge/gdscript-lsp-bridge.mjs", import.meta.url)
);

function createInitializeRequest() {
  return Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        rootUri: "file:///Users/test/project",
      },
    })
  );
}

async function startServer(onClient) {
  const server = net.createServer(onClient);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    port: address.port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}

function spawnBridge(port) {
  return spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      ...process.env,
      GODOT_LSP_HOST: "127.0.0.1",
      GODOT_LSP_INITIAL_MAX_ATTEMPTS: "2",
      GODOT_LSP_MODE: "attach",
      GODOT_LSP_PORT: String(port),
      GODOT_LSP_RETRY_DELAY_MS: "10",
      GODOT_LSP_RUNTIME_MAX_RETRIES: "2",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function waitForBridgeMessage(stream) {
  return new Promise((resolve) => {
    const parser = new LspParser((body) => resolve(body));
    stream.on("data", (chunk) => parser.feed(chunk));
  });
}

test("bridge forwards initialize responses in attach mode", async () => {
  const server = await startServer((socket) => {
    const parser = new LspParser((body) => {
      const message = JSON.parse(body.toString("utf8"));
      socket.write(
        encodeLspMessage(
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { capabilities: {} },
            })
          )
        )
      );
    });

    socket.on("data", (chunk) => parser.feed(chunk));
  });
  const bridge = spawnBridge(server.port);

  try {
    const responsePromise = waitForBridgeMessage(bridge.stdout);
    bridge.stdin.write(encodeLspMessage(createInitializeRequest()));

    const response = JSON.parse((await responsePromise).toString("utf8"));
    assert.equal(response.id, 0);
    assert.deepEqual(response.result, { capabilities: {} });
  } finally {
    bridge.kill();
    await once(bridge, "exit");
    await server.close();
  }
});

test("bridge exits when a live backend socket drops", async () => {
  const server = await startServer((socket) => {
    const parser = new LspParser(() => {
      socket.destroy();
    });

    socket.on("data", (chunk) => parser.feed(chunk));
  });
  const bridge = spawnBridge(server.port);

  try {
    bridge.stdin.write(encodeLspMessage(createInitializeRequest()));

    const [exitCode] = await Promise.race([
      once(bridge, "exit"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("bridge did not exit after socket drop")), 250)
      ),
    ]);

    assert.equal(exitCode, 1);
  } finally {
    bridge.kill();
    await server.close();
  }
});

test("bridge resolves project-aware backends in auto mode", async () => {
  const server = await startServer((socket) => {
    const parser = new LspParser((body) => {
      const message = JSON.parse(body.toString("utf8"));
      socket.write(
        encodeLspMessage(
          Buffer.from(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { capabilities: { hoverProvider: true } },
            })
          )
        )
      );
    });

    socket.on("data", (chunk) => parser.feed(chunk));
  });
  const registryDir = await mkdtemp(
    path.join(tmpdir(), "gdscript-lsp-bridge-auto-")
  );
  const projectRoot = "/Users/test/project";

  await writeProjectRecord({
    projectRoot,
    registryDir,
    record: {
      host: "127.0.0.1",
      mode: "headless",
      pid: 5555,
      port: server.port,
      projectRoot,
      startedAt: "2026-03-07T12:00:00.000Z",
      updatedAt: "2026-03-07T12:00:00.000Z",
    },
  });

  const bridge = spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      ...process.env,
      GODOT_LSP_HOST: "10.0.0.25",
      GODOT_LSP_MODE: "auto",
      GODOT_LSP_REGISTRY_DIR: registryDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const responsePromise = waitForBridgeMessage(bridge.stdout);
    bridge.stdin.write(encodeLspMessage(createInitializeRequest()));

    const response = JSON.parse((await responsePromise).toString("utf8"));
    assert.equal(response.id, 0);
    assert.deepEqual(response.result, { capabilities: { hoverProvider: true } });
  } finally {
    bridge.kill();
    await once(bridge, "exit");
    await server.close();
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("bridge exits when auto mode initialize does not provide a project root", async () => {
  const registryDir = await mkdtemp(
    path.join(tmpdir(), "gdscript-lsp-bridge-missing-root-")
  );
  const bridge = spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      ...process.env,
      GODOT_LSP_MODE: "auto",
      GODOT_LSP_REGISTRY_DIR: registryDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    bridge.stdin.write(
      encodeLspMessage(
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 0,
            method: "initialize",
            params: {},
          })
        )
      )
    );

    const [exitCode] = await Promise.race([
      once(bridge, "exit"),
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(new Error("bridge did not exit when initialize omitted project root")),
          250
        )
      ),
    ]);

    assert.equal(exitCode, 1);
  } finally {
    bridge.kill();
    await rm(registryDir, { force: true, recursive: true });
  }
});

test("two auto-mode bridge processes converge on one backend for the same project", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "gdscript-lsp-two-bridges-"));
  const registryDir = path.join(tempDir, "registry");
  const launcherPath = path.join(tempDir, "fake-godot.mjs");
  const launcherLog = path.join(tempDir, "launcher.log");
  const projectRoot = "/Users/test/project";

  await writeFile(
    launcherPath,
    `#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import net from "node:net";

const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--lsp-port") + 1]);
const logPath = process.env.FAKE_GODOT_LOG;

class LspParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\\r\\n\\r\\n");
        if (headerEnd === -1) return;
        const headers = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = headers.match(/Content-Length:\\s*(\\d+)/i);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }
        this.contentLength = Number.parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) return;
      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      this.onMessage(body);
    }
  }
}

function encode(body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([
    Buffer.from(\`Content-Length: \${payload.byteLength}\\r\\n\\r\\n\`, "ascii"),
    payload,
  ]);
}

const server = net.createServer((socket) => {
  const parser = new LspParser((body) => {
    const message = JSON.parse(body.toString("utf8"));
    socket.write(
      encode(
        Buffer.from(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { capabilities: { definitionProvider: true } },
          })
        )
      )
    );
  });

  socket.on("data", (chunk) => parser.feed(chunk));
});

server.listen(port, "127.0.0.1", async () => {
  await appendFile(logPath, \`\${process.pid}:\${port}\\n\`);
});

setInterval(() => {}, 1000);
`
  );
  await chmod(launcherPath, 0o755);

  const bridgeOne = spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      ...process.env,
      FAKE_GODOT_LOG: launcherLog,
      GODOT_EDITOR_PATH: launcherPath,
      GODOT_LSP_MODE: "auto",
      GODOT_LSP_REGISTRY_DIR: registryDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bridgeTwo = spawn(process.execPath, [BRIDGE_PATH], {
    env: {
      ...process.env,
      FAKE_GODOT_LOG: launcherLog,
      GODOT_EDITOR_PATH: launcherPath,
      GODOT_LSP_MODE: "auto",
      GODOT_LSP_REGISTRY_DIR: registryDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const responseOne = waitForBridgeMessage(bridgeOne.stdout);
    const responseTwo = waitForBridgeMessage(bridgeTwo.stdout);

    bridgeOne.stdin.write(encodeLspMessage(createInitializeRequest()));
    bridgeTwo.stdin.write(encodeLspMessage(createInitializeRequest()));

    const [first, second] = await Promise.all([responseOne, responseTwo]);
    assert.equal(JSON.parse(first.toString("utf8")).id, 0);
    assert.equal(JSON.parse(second.toString("utf8")).id, 0);

    const record = await readProjectRecord({ projectRoot, registryDir });
    assert.ok(record?.pid);

    const launches = (await readFile(launcherLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.equal(launches.length, 1);

    process.kill(record.pid, "SIGTERM");
  } finally {
    bridgeOne.kill();
    bridgeTwo.kill();
    await Promise.all([once(bridgeOne, "exit"), once(bridgeTwo, "exit")]);
    await rm(tempDir, { force: true, recursive: true });
  }
});
