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
    ["bash", "git merge-base --is-ancestor main HEAD", "allow"],
    ["bash", "git worktree list", "allow"],
    ["bash", "git worktree add -b task ../task main", "allow"],
    ["bash", "git worktree remove ../task", "allow"],
    ["bash", "git -C /repo worktree remove ../task", "allow"],
    ["bash", "git worktree remove --force ../task", "ask"],
    ["bash", "git worktree remove ../task -f", "ask"],
    ["bash", "git worktree remove -vf ../task", "ask"],
    ["bash", "git -C /repo worktree remove --force ../task", "ask"],
    ["bash", "git worktree add --force ../task main", "ask"],
    ["bash", "git worktree add -B task ../task main", "ask"],
    ["bash", "git cherry-pick abc123", "allow"],
    ["bash", "git -C /repo cherry-pick abc123", "allow"],
    ["bash", "git cherry-pick --continue", "allow"],
    ["bash", "git cherry-pick --abort", "ask"],
    ["bash", "git cherry-pick --ab", "ask"],
    ["bash", "git -C /repo cherry-pick --abort", "ask"],
    ["bash", "git cherry-pick --skip", "ask"],
    ["bash", "git cherry-pick --sk", "ask"],
    ["bash", "git -C /repo cherry-pick --skip", "ask"],
    ["bash", "git cherry-pick --quit", "ask"],
    ["bash", "git cherry-pick --qu", "ask"],
    ["bash", "git switch main", "allow"],
    ["bash", "git switch feature-name", "allow"],
    ["bash", "git switch -c task", "allow"],
    ["bash", "git -C /repo switch main", "allow"],
    ["bash", "git switch --discard-changes main", "ask"],
    ["bash", "git switch -f main", "ask"],
    ["bash", "git switch -df HEAD", "ask"],
    ["bash", "git switch -C task", "ask"],
    ["bash", "git switch main --discard-changes", "ask"],
    ["bash", "git switch -c task -f", "ask"],
    ["bash", "git switch -c -f main", "ask"],
    ["bash", "git switch --force-create task", "ask"],
    ["bash", "git switch --merge main", "ask"],
    ["bash", "git switch --orphan task", "ask"],
    ["bash", "git checkout main", "ask"],
    ["bash", "git checkout -- file.txt", "ask"],
    ["bash", "git checkout HEAD file.txt", "ask"],
    ["bash", "git -C /repo checkout -- file.txt", "ask"],
    ["bash", "git checkout --detach HEAD", "allow"],
    ["bash", "git -C /repo checkout --detach HEAD", "allow"],
    ["bash", "git checkout --detach -f HEAD", "ask"],
    ["bash", "git checkout --detach HEAD --force", "ask"],
    ["bash", "git checkout --detach -qm HEAD", "ask"],
    ["bash", "git -C /repo checkout --detach HEAD -f", "ask"],
    ["bash", "git merge main", "ask"],
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
