import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CandidateExec } from "./verification.ts";

type CommandResult = Awaited<ReturnType<CandidateExec>>;
export type StagedRuntimeInput = Readonly<{ path: string; sha256: string }>;
export type StagedSnapshot = Readonly<{
  directory: string;
  cwd: string;
  repositoryRoot: string;
  head: string;
  tree: string;
  runtimeInputs: readonly StagedRuntimeInput[];
  validate(): Promise<void>;
  cleanup(): void;
}>;

function hash(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }
function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}
async function git(exec: CandidateExec, root: string, argv: string[], privateIndex?: string): Promise<string> {
  const result: CommandResult = privateIndex === undefined
    ? await exec("git", argv, { cwd: root })
    : await exec("env", [`GIT_INDEX_FILE=${privateIndex}`, "git", ...argv], { cwd: root });
  if (result.code !== 0) throw new Error(`staged snapshot git ${argv.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
type RuntimeEntry = Readonly<{ path: string; kind: "directory" | "file"; mode: number; sha256?: string }>;

function runtimeManifest(root: string, input: string, destination?: string): string {
  const source = resolve(root, input);
  if (!within(root, source)) throw new Error(`runtime input escapes repository: ${input}`);
  const entries: RuntimeEntry[] = [];
  const visit = (path: string, relativePath: string, copyTo?: string) => {
    let metadata;
    try { metadata = lstatSync(path); } catch (error) { throw new Error(`runtime input is missing or unreadable: ${input} (${String(error)})`); }
    if (metadata.isSymbolicLink()) throw new Error(`runtime input contains a symbolic link: ${input}`);
    let canonical: string;
    try { canonical = realpathSync(path); } catch (error) { throw new Error(`runtime input cannot be resolved: ${input} (${String(error)})`); }
    if (!within(root, canonical) || canonical !== path) throw new Error(`runtime input escapes repository through a symbolic link: ${input}`);
    const mode = metadata.mode & 0o777;
    if (metadata.isDirectory()) {
      entries.push({ path: relativePath, kind: "directory", mode });
      if (copyTo !== undefined) mkdirSync(copyTo, { recursive: true, mode: 0o700 });
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relativePath ? `${relativePath}/${name}` : name, copyTo === undefined ? undefined : join(copyTo, name));
      }
      if (copyTo !== undefined) chmodSync(copyTo, mode);
      return;
    }
    if (!metadata.isFile()) throw new Error(`runtime input must contain only regular files and directories: ${input}`);
    const bytes = readFileSync(path);
    entries.push({ path: relativePath, kind: "file", mode, sha256: hash(bytes) });
    if (copyTo !== undefined) {
      writeFileSync(copyTo, bytes, { mode });
      chmodSync(copyTo, mode);
    }
  };
  visit(source, "", destination);
  return hash(Buffer.from(JSON.stringify(entries)));
}

function removeSnapshotDirectory(directory: string): void {
  const makeWritable = (path: string) => {
    if (!lstatSync(path).isDirectory()) return;
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  };
  makeWritable(directory);
  rmSync(directory, { recursive: true, force: true });
}

async function requireIgnored(exec: CandidateExec, root: string, input: string): Promise<void> {
  const result = await exec("git", ["check-ignore", "--quiet", "--no-index", "--", input], { cwd: root });
  if (result.code === 0) return;
  if (result.code === 1) throw new Error(`runtime input must be ignored by Git: ${input}`);
  throw new Error(`could not verify ignored runtime input ${input}: ${result.stderr || result.stdout}`);
}

function snapshotFiles(root: string, directory: string): Map<string, { mode: number; sha256?: string }> {
  const files = new Map<string, { mode: number; sha256?: string }>();
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const name = relative(directory, path);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`staged snapshot source contains a symbolic link: ${name}`);
      if (entry.isDirectory()) {
        files.set(name, { mode: metadata.mode & 0o777 });
        visit(path);
      } else if (entry.isFile()) files.set(name, { mode: metadata.mode & 0o777, sha256: hash(readFileSync(path)) });
    }
  };
  visit(root);
  return files;
}

export async function createStagedSnapshot(
  exec: CandidateExec,
  repositoryRoot: string,
  cwd = ".",
  runtimeInputPaths: readonly string[] = [],
): Promise<StagedSnapshot> {
  const root = realpathSync(repositoryRoot);
  if (!isAbsolute(repositoryRoot) || root !== repositoryRoot || !statSync(root).isDirectory()) throw new Error("staged snapshot repository root must be an absolute real directory");
  if (cwd.includes("\\") || isAbsolute(cwd) || cwd.split("/").includes("..")) throw new Error("staged snapshot cwd must be repository-relative");
  const head = (await git(exec, root, ["rev-parse", "--verify", "HEAD"])).trim();
  const indexPath = (await git(exec, root, ["rev-parse", "--git-path", "index"])).trim();
  const absoluteIndex = resolve(root, indexPath);
  if (!existsSync(absoluteIndex)) throw new Error("staged snapshot requires an existing Git index");
  const temporary = mkdtempSync(join(tmpdir(), "pi-staged-verification-"));
  const directory = join(temporary, "source");
  mkdirSync(directory);
  const privateIndex = join(temporary, "index");
  copyFileSync(absoluteIndex, privateIndex);
  let retained = false;
  try {
    const tree = (await git(exec, root, ["write-tree"], privateIndex)).trim();
    const stagedPaths = (await git(exec, root, ["ls-files", "-z", "--cached"], privateIndex)).split("\0").filter(Boolean);
    await git(exec, root, ["checkout-index", "--all", "--ignore-skip-worktree-bits", `--prefix=${directory}${sep}`], privateIndex);
    const tracked = new Set([
      ...(await git(exec, root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"])).split("\0"),
      ...stagedPaths,
    ].filter(Boolean));
    const runtimeInputs: StagedRuntimeInput[] = [];
    for (const input of runtimeInputPaths) {
      if (typeof input !== "string" || input.length === 0 || input.includes("\0") || input.includes("\\") || isAbsolute(input) || input.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`invalid repository-relative runtime input: ${input}`);
      if ([...tracked].some((path) => path === input || path.startsWith(`${input}/`) || input.startsWith(`${path}/`))) throw new Error(`runtime input overlaps staged tracked source: ${input}`);
      await requireIgnored(exec, root, input);
      const destination = join(directory, input);
      if (!within(directory, destination)) throw new Error(`runtime input escapes staged snapshot: ${input}`);
      mkdirSync(dirname(destination), { recursive: true });
      const sha256 = runtimeManifest(root, input, destination);
      runtimeInputs.push({ path: input, sha256 });
    }
    if (!within(directory, resolve(directory, cwd)) || !existsSync(resolve(directory, cwd)) || !statSync(resolve(directory, cwd)).isDirectory()) throw new Error(`staged snapshot cwd does not exist: ${cwd}`);
    const frozenInputs = Object.freeze(runtimeInputs.map((item) => Object.freeze(item)));
    const initialFiles = snapshotFiles(directory, directory);
    const snapshot: StagedSnapshot = Object.freeze({
      directory,
      cwd: resolve(directory, cwd),
      repositoryRoot: root,
      head,
      tree,
      runtimeInputs: frozenInputs,
      async validate() {
        if ((await git(exec, root, ["rev-parse", "--verify", "HEAD"])).trim() !== head) throw new Error("staged snapshot HEAD changed");
        const validationIndex = join(temporary, "validation-index");
        copyFileSync(absoluteIndex, validationIndex);
        try {
          if ((await git(exec, root, ["write-tree"], validationIndex)).trim() !== tree) throw new Error("staged snapshot tree changed");
        } finally {
          rmSync(validationIndex, { force: true });
        }
        const currentFiles = snapshotFiles(directory, directory);
        if (JSON.stringify([...currentFiles]) !== JSON.stringify([...initialFiles])) throw new Error("staged snapshot source image changed");
        for (const item of frozenInputs) {
          if (runtimeManifest(root, item.path) !== item.sha256) throw new Error(`staged snapshot runtime input changed: ${item.path}`);
        }
      },
      cleanup() { if (!retained) { removeSnapshotDirectory(temporary); retained = true; } },
    });
    return snapshot;
  } catch (error) {
    removeSnapshotDirectory(temporary);
    throw error;
  }
}
