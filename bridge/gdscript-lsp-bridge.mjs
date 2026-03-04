#!/usr/bin/env node

// TCP-to-stdio bridge for Godot's built-in GDScript LSP server.
// Reads LSP JSON-RPC messages from stdin (Claude Code) and forwards them
// to Godot's LSP over TCP, and vice versa.

import { connect } from "net";

const HOST = process.env.GODOT_LSP_HOST || "127.0.0.1";
const PORT = parseInt(process.env.GODOT_LSP_PORT || "6005", 10);
const MAX_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 500;

const log = (msg) => process.stderr.write(`[gdscript-lsp-bridge] ${msg}\n`);

// --- LSP message framing ---

// Parses LSP messages from a stream of raw bytes. LSP uses:
//   Content-Length: <N>\r\n\r\n<JSON payload of N bytes>
class LspParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this._parse();
  }

  _parse() {
    while (true) {
      if (this.contentLength === -1) {
        // Look for the end of headers
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const headers = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = headers.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          log(`Malformed LSP header, discarding: ${headers}`);
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      // Wait until we have the full body
      if (this.buffer.length < this.contentLength) return;

      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;

      this.onMessage(body);
    }
  }
}

function encodeLspMessage(body) {
  const len = Buffer.byteLength(body);
  return Buffer.from(`Content-Length: ${len}\r\n\r\n${body}`);
}

// --- Connection management ---

function connectToGodot(attempt = 1) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port: PORT }, () => {
      log(`Connected to Godot LSP at ${HOST}:${PORT}`);
      resolve(socket);
    });

    socket.once("error", (err) => {
      if (attempt >= MAX_RETRIES) {
        reject(
          new Error(
            `Failed to connect to Godot LSP at ${HOST}:${PORT} after ${MAX_RETRIES} attempts: ${err.message}`
          )
        );
        return;
      }

      const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      log(
        `Connection attempt ${attempt} failed (${err.message}), retrying in ${delay}ms...`
      );
      setTimeout(() => connectToGodot(attempt + 1).then(resolve, reject), delay);
    });
  });
}

// --- Main ---

async function main() {
  let socket;
  try {
    socket = await connectToGodot();
  } catch (err) {
    log(err.message);
    log(
      "Make sure Godot editor is running, or start headless: godot --gdscript-lsp --path <project>"
    );
    process.exit(1);
  }

  // stdin → TCP (Claude Code → Godot)
  const stdinParser = new LspParser((body) => {
    socket.write(encodeLspMessage(body));
  });

  process.stdin.on("data", (chunk) => stdinParser.feed(chunk));

  // TCP → stdout (Godot → Claude Code)
  const tcpParser = new LspParser((body) => {
    process.stdout.write(encodeLspMessage(body));
  });

  socket.on("data", (chunk) => tcpParser.feed(chunk));

  // Clean shutdown
  const shutdown = () => {
    socket.destroy();
    process.exit(0);
  };

  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  socket.on("close", () => {
    log("Godot LSP connection closed");
    process.exit(0);
  });

  socket.on("error", (err) => {
    log(`TCP error: ${err.message}`);
    process.exit(1);
  });
}

main();
