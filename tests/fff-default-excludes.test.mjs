import assert from "node:assert/strict";
import test from "node:test";

import fffDefaultExcludes, {
  addDefaultFffExcludes,
  capFffOutput,
} from "../extensions/fff-default-excludes.ts";

test("adds defaults without replacing caller exclusions", () => {
  const input = { exclude: "dist/" };
  addDefaultFffExcludes(input);
  assert.deepEqual(input.exclude, [
    "dist/",
    "sessions/",
    "*.jsonl",
    "node_modules/",
    "install/",
    "logs/",
    "*.log",
    "*.log.*",
  ]);
});

test("leaves explicit noisy paths searchable", () => {
  const paths = [
    "sessions/",
    "node_modules/pkg/src/",
    "/tmp/install/x",
    "*.jsonl",
    "logs/*.log",
  ];

  for (const path of paths) {
    const input = { path };
    addDefaultFffExcludes(input);
    assert.equal(input.exclude, undefined);
  }
});

test("patches both FFF naming modes", () => {
  const handlers = {};
  fffDefaultExcludes({ on: (event, callback) => (handlers[event] = callback) });
  const handler = handlers.tool_call;

  for (const toolName of ["ffgrep", "fffind", "grep", "find"]) {
    const input = {};
    handler({ toolName, input });
    assert.ok(input.exclude.includes("sessions/"));
  }
});

for (const [name, text, truncated] of [
  ["small output passes through", "a\nb", false],
  ["too many lines", "x\n".repeat(3000), true],
  ["too many bytes", "y".repeat(400) + "\n".concat("z".repeat(400)).repeat(200), true],
  ["one line over the byte cap", "w".repeat(200_000), true],
]) {
  test(`caps FFF output: ${name}`, () => {
    const capped = capFffOutput(text);
    if (!truncated) return assert.equal(capped, undefined);
    assert.ok(capped.includes("[Output truncated"));
    assert.ok(capped.split("\n").length <= 2003);
    assert.ok(Buffer.byteLength(capped) <= 50 * 1024 + 200);
  });
}

test("tool_result replaces oversized FFF output only", () => {
  const handlers = {};
  fffDefaultExcludes({ on: (event, callback) => (handlers[event] = callback) });
  const big = [{ type: "text", text: "x\n".repeat(3000) }];
  assert.ok(handlers.tool_result({ toolName: "ffgrep", content: big }).content[0].text.includes("[Output truncated"));
  assert.equal(handlers.tool_result({ toolName: "bash", content: big }), undefined);
  assert.equal(handlers.tool_result({ toolName: "ffgrep", content: [{ type: "text", text: "ok" }] }), undefined);
});
