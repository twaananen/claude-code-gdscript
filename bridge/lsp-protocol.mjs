import path from "node:path";
import { fileURLToPath } from "node:url";

export class LspParser {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
    this.contentLength = -1;
  }

  feed(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    this.#parse();
  }

  #parse() {
    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        const headers = this.buffer.subarray(0, headerEnd).toString("ascii");
        const match = headers.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = Number.parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.buffer.length < this.contentLength) {
        return;
      }

      const body = this.buffer.subarray(0, this.contentLength);
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = -1;
      this.onMessage(body);
    }
  }
}

export function encodeLspMessage(body) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.byteLength}\r\n\r\n`, "ascii"),
    payload,
  ]);
}

function fromFileUri(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

function normalizeProjectRoot(projectRoot) {
  if (!projectRoot) {
    return null;
  }

  return path.normalize(projectRoot).replace(/[\\/]+$/, "");
}

function pickProjectRoot(params) {
  const candidateUris = [
    params?.rootUri,
    params?.workspaceFolders?.[0]?.uri,
  ].filter(Boolean);

  for (const uri of candidateUris) {
    const projectRoot = fromFileUri(uri);
    if (projectRoot) {
      return projectRoot;
    }
  }

  return params?.rootPath || params?.workspaceFolders?.[0]?.path || null;
}

export function extractProjectContextFromMessage(body) {
  let message;

  try {
    message = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : body);
  } catch {
    return null;
  }

  if (message?.method !== "initialize") {
    return null;
  }

  const projectRoot = normalizeProjectRoot(pickProjectRoot(message.params));
  if (!projectRoot) {
    return null;
  }

  return {
    clientName: message.params?.clientInfo?.name || "unknown-client",
    projectName:
      message.params?.workspaceFolders?.[0]?.name || path.basename(projectRoot),
    projectRoot,
  };
}
