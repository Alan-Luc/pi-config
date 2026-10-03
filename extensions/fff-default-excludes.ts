import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SEARCH_TOOLS = new Set(["ffgrep", "fffind", "grep", "find"]);
const DEFAULT_EXCLUDES = [
  "sessions/",
  "*.jsonl",
  "node_modules/",
  "install/",
  "logs/",
  "*.log",
  "*.log.*",
];

function explicitlyTargetsExcludedPath(path: unknown): boolean {
  if (typeof path !== "string") return false;

  const normalized = path.replaceAll("\\", "/");
  return (
    /(^|\/)(sessions|node_modules|install|logs)(\/|$)/i.test(normalized) ||
    /\.(jsonl|log)(\.|$)/i.test(normalized)
  );
}

export function addDefaultFffExcludes(input: Record<string, unknown>): void {
  if (explicitlyTargetsExcludedPath(input.path)) return;

  const existing = Array.isArray(input.exclude)
    ? input.exclude
    : typeof input.exclude === "string"
      ? [input.exclude]
      : [];
  input.exclude = [...existing, ...DEFAULT_EXCLUDES];
}

// Pi caps built-in tool output at these limits; pi-fff caps only line length and
// match count, so one noisy file once returned 2.5 MB.
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

export function capFffOutput(text: string): string | undefined {
  const lines = text.split("\n");
  if (lines.length <= MAX_LINES && Buffer.byteLength(text) <= MAX_BYTES) return undefined;

  let kept = lines.slice(0, MAX_LINES).join("\n");
  if (Buffer.byteLength(kept) > MAX_BYTES) {
    kept = Buffer.from(kept).subarray(0, MAX_BYTES).toString();
    const lastNewline = kept.lastIndexOf("\n");
    if (lastNewline > 0) kept = kept.slice(0, lastNewline);
  }
  return `${kept}\n\n[Output truncated to ${MAX_LINES} lines / ${MAX_BYTES / 1024} KB. Narrow the search with path, exclude, a lower limit, or less context.]`;
}

export default function fffDefaultExcludes(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (SEARCH_TOOLS.has(event.toolName)) {
      addDefaultFffExcludes(event.input as Record<string, unknown>);
    }
  });

  pi.on("tool_result", (event) => {
    if (!SEARCH_TOOLS.has(event.toolName)) return;
    const text = event.content.map((part) => (part.type === "text" ? part.text : "")).join("");
    const capped = capFffOutput(text);
    if (capped !== undefined) return { content: [{ type: "text", text: capped }] };
  });
}
