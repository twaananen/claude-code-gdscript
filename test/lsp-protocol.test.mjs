import assert from "node:assert/strict";
import test from "node:test";

import {
  LspParser,
  encodeLspMessage,
  extractProjectContextFromMessage,
} from "../bridge/lsp-protocol.mjs";

test("LspParser emits complete messages across chunk boundaries", () => {
  const seen = [];
  const parser = new LspParser((body) => seen.push(body.toString("utf8")));

  const encoded = encodeLspMessage(Buffer.from('{"jsonrpc":"2.0","id":1}'));
  parser.feed(encoded.subarray(0, 10));
  parser.feed(encoded.subarray(10));

  assert.deepEqual(seen, ['{"jsonrpc":"2.0","id":1}']);
});

test("extractProjectContextFromMessage reads initialize rootUri", () => {
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        rootUri: "file:///Users/test/project-space",
        clientInfo: { name: "Claude Code" },
      },
    })
  );

  assert.deepEqual(extractProjectContextFromMessage(body), {
    clientName: "Claude Code",
    projectName: "project-space",
    projectRoot: "/Users/test/project-space",
  });
});

test("extractProjectContextFromMessage falls back to workspaceFolders", () => {
  const body = Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        workspaceFolders: [
          {
            uri: "file:///Users/test/another-project",
            name: "another-project",
          },
        ],
      },
    })
  );

  assert.deepEqual(extractProjectContextFromMessage(body), {
    clientName: "unknown-client",
    projectName: "another-project",
    projectRoot: "/Users/test/another-project",
  });
});
