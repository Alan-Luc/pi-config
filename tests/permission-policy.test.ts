import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type State = "allow" | "ask" | "deny";
type Rule = State | { action: "deny"; reason: string };
type Policy = Record<string, State | Record<string, Rule>>;

const config = JSON.parse(
  readFileSync(
    resolve(import.meta.dir, "../extensions/pi-permission-system/config.json"),
    "utf8",
  ),
) as { yoloMode: boolean; permission: Policy };

function globMatches(pattern: string, value: string): boolean {
  const regex = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}$`).test(value);
}

function resolvePolicy(surface: string, value: string): State {
  const rules = config.permission[surface] ?? config.permission["*"];
  if (typeof rules === "string") return rules;
  let result: State = config.permission["*"] as State;
  for (const [pattern, state] of Object.entries(rules)) {
    if (globMatches(pattern, value)) result = typeof state === "string" ? state : state.action;
  }
  return result;
}

describe("global permission policy", () => {
  test("disables yolo mode so ask rules prompt", () => {
    expect(config.yoloMode).toBe(false);
  });

  test.each([
    ["bash", "pnpm typecheck", "allow"],
    ["bash", "bun test", "allow"],
    ["bash", "git status", "allow"],
    ["bash", "git diff", "allow"],
    ["bash", "git commit -m message", "allow"],
    ["bash", "git push origin main", "allow"],
    ["bash", "git rebase main", "ask"],
    ["bash", "git reset --hard", "ask"],
    ["bash", "git push --force origin main", "ask"],
    ["bash", "git commit --amend", "ask"],
    ["bash", "rm -rf /", "deny"],
    ["bash", "sed -i '' 's/a/b/' file.md", "deny"],
    ["bash", "sed -E -i 's/a/b/' file.md", "deny"],
    ["bash", "sed --in-place 's/a/b/' file.md", "deny"],
    ["bash", "sed -n '1,20p' file.md", "allow"],
    ["bash", "sed -E 's/a/b/'", "allow"],
    ["path", ".env", "deny"],
    ["path", ".env.local", "deny"],
    ["path", ".env.example", "allow"],
  ] as const)("resolves %s %s as %s", (surface, value, expected) => {
    expect(resolvePolicy(surface, value)).toBe(expected);
  });

  test("uses documented last-match-wins ordering", () => {
    expect(resolvePolicy("path", ".env.example")).toBe("allow");
    expect(resolvePolicy("bash", "git push --prune origin main")).toBe("ask");
  });
});
