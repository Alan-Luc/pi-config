import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { realpath } from "node:fs/promises";

const HASH = /^[0-9a-f]{40,64}$/;

export type PublicationGrant = {
	enabled: boolean;
	instance: string;
	project: string;
	pushUrl: string;
	branchPrefix: "TASK-" | `TASK-${string}`;
	actions: readonly ["push"];
	maxCommits: number;
	scannerId: string;
};

export type NormalizedPublicationRequest = {
	action: "push";
	remote: "origin";
	branch: string;
	isChild: boolean;
	force: boolean;
	delete: boolean;
	mirror: boolean;
	prune: boolean;
	refspec: boolean;
	retarget: boolean;
	override: boolean;
};

export type FrozenPublicationCandidate = {
	head: string;
	tree: string;
	branch: string;
	indexTree: string;
	statusDigest: string;
	inputDigest: string;
};

export type PublicationTarget = {
	instance: string;
	project: string;
	protected: boolean;
	remoteHead: string;
};

export type PublicationScanRequest = {
	candidateFingerprint: string;
	commitIds: readonly string[];
	blobIds: readonly string[];
	objectSetDigest: string;
};

export type PublicationScanResult = {
	scannerId: string;
	candidateFingerprint: string;
	commitIds: readonly string[];
	blobIds: readonly string[];
	objectSetDigest: string;
	passed: boolean;
};

export type PublicationRuntime = {
	cwd: string;
	loadGrant: () => Promise<PublicationGrant | undefined>;
	resolveTarget: (pushUrl: string, branch: string) => Promise<PublicationTarget | undefined>;
	loadFrozenCandidate: () => Promise<FrozenPublicationCandidate | undefined>;
	isCandidateCurrent: (candidate: FrozenPublicationCandidate) => Promise<boolean>;
	scan?: (request: PublicationScanRequest) => Promise<PublicationScanResult>;
};

export type PublicationDecision =
	| { allowed: true; candidateFingerprint: string; commitIds: readonly string[]; blobIds: readonly string[]; scannerId: string }
	| { allowed: false; reason: string };

const deny = (reason: string): PublicationDecision => ({ allowed: false, reason });
const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
	Object.keys(value).every((key) => keys.includes(key));
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
	left.length === right.length && left.every((id, index) => id === right[index]);

function git(cwd: string, args: string[], input?: string): Promise<string> {
	return new Promise((resolveResult, reject) => {
		let inputError: Error | undefined;
		const child = execFile("git", args, { cwd, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
			const failure = error ?? inputError;
			if (failure) reject(failure);
			else resolveResult(stdout.trim());
		});
		child.stdin?.on("error", (error: Error) => { inputError = error; });
		child.stdin?.end(input);
	});
}

function validCandidate(candidate: unknown): candidate is FrozenPublicationCandidate {
	if (!isRecord(candidate) || !hasOnlyKeys(candidate, ["head", "tree", "branch", "indexTree", "statusDigest", "inputDigest"])) return false;
	return typeof candidate.head === "string" && HASH.test(candidate.head)
		&& typeof candidate.tree === "string" && HASH.test(candidate.tree)
		&& typeof candidate.indexTree === "string" && HASH.test(candidate.indexTree)
		&& typeof candidate.branch === "string" && candidate.branch.length > 0
		&& typeof candidate.statusDigest === "string" && /^[0-9a-f]{64}$/.test(candidate.statusDigest)
		&& typeof candidate.inputDigest === "string" && /^[0-9a-f]{64}$/.test(candidate.inputDigest);
}

function validGrant(grant: unknown): grant is PublicationGrant {
	if (!isRecord(grant) || !hasOnlyKeys(grant, ["enabled", "instance", "project", "pushUrl", "branchPrefix", "actions", "maxCommits", "scannerId"])) return false;
	return grant.enabled === true && typeof grant.instance === "string" && /^https:\/\//.test(grant.instance)
		&& typeof grant.project === "string" && grant.project.length > 0
		&& typeof grant.pushUrl === "string" && grant.pushUrl.length > 0
		&& typeof grant.branchPrefix === "string" && /^TASK-[A-Za-z0-9._/-]*$/.test(grant.branchPrefix)
		&& Array.isArray(grant.actions) && grant.actions.length === 1 && grant.actions[0] === "push"
		&& typeof grant.maxCommits === "number" && Number.isSafeInteger(grant.maxCommits)
		&& grant.maxCommits > 0 && grant.maxCommits <= 100
		&& typeof grant.scannerId === "string" && grant.scannerId.length > 0;
}

function validRequest(request: unknown): request is NormalizedPublicationRequest {
	if (!isRecord(request) || !hasOnlyKeys(request, ["action", "remote", "branch", "isChild", "force", "delete", "mirror", "prune", "refspec", "retarget", "override"])) return false;
	return request.action === "push" && request.remote === "origin" && typeof request.branch === "string"
		&& typeof request.isChild === "boolean" && !request.isChild
		&& [request.force, request.delete, request.mirror, request.prune, request.refspec, request.retarget, request.override].every((value) => value === false)
		&& /^TASK-[A-Za-z0-9._/-]+$/.test(request.branch);
}

async function outgoingObjects(cwd: string, remoteHead: string, head: string): Promise<{ commits: string[]; blobs: string[] }> {
	if (!HASH.test(remoteHead) || !HASH.test(head)) throw new Error("invalid object identity");
	const range = `${remoteHead}..${head}`;
	const commitsOutput = await git(cwd, ["rev-list", "--reverse", range]);
	const commits = commitsOutput ? commitsOutput.split("\n") : [];
	const objectsOutput = await git(cwd, ["rev-list", "--objects", "--no-object-names", range]);
	const objects = [...new Set(objectsOutput.split("\n").filter(Boolean))];
	if (objects.some((object) => !HASH.test(object))) throw new Error("invalid object listing");
	if (objects.length === 0) return { commits, blobs: [] };
	const rows = (await git(cwd, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], `${objects.join("\n")}\n`)).split("\n");
	if (rows.length !== objects.length) throw new Error("incomplete object type listing");
	const blobs: string[] = [];
	for (const [index, row] of rows.entries()) {
		const [object, type, extra] = row.split(" ");
		if (object !== objects[index] || extra !== undefined || !["blob", "tree", "commit", "tag"].includes(type)) throw new Error("invalid object type listing");
		if (type === "blob") blobs.push(object);
	}
	return { commits, blobs: blobs.sort() };
}

export async function authorizeGitPublication(
	request: NormalizedPublicationRequest,
	runtime: PublicationRuntime,
): Promise<PublicationDecision> {
	if (!validRequest(request)) return deny("publication request is not an allowed parent push shape");
	if (!runtime || typeof runtime.cwd !== "string" || !runtime.loadGrant || !runtime.resolveTarget
		|| !runtime.loadFrozenCandidate || !runtime.isCandidateCurrent || !runtime.scan) {
		return deny("trusted publication grant, target, candidate, or scanner adapter unavailable");
	}

	try {
		const grant = await runtime.loadGrant();
		if (!validGrant(grant)) return deny("explicit publication grant unavailable or invalid");
		const cwd = await realpath(resolve(runtime.cwd));
		const top = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"]));
		if (top !== cwd) return deny("Git worktree root does not match the frozen candidate root");
		const [head, tree, branch, indexTree, status, pushUrlOutput] = await Promise.all([
			git(cwd, ["rev-parse", "HEAD"]),
			git(cwd, ["rev-parse", "HEAD^{tree}"]),
			git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
			git(cwd, ["write-tree"]),
			git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
			git(cwd, ["remote", "get-url", "--push", "--all", request.remote]),
		]);
		if (status) return deny("worktree has uncommitted or untracked changes");
		if (await git(cwd, ["rev-parse", `refs/heads/${branch}`]) !== head) return deny("current branch ref does not match the checked-out candidate");
		const pushUrls = pushUrlOutput.split("\n").filter(Boolean);
		if (pushUrls.length !== 1 || pushUrls[0] !== grant.pushUrl) return deny("configured push URL does not match the explicit grant");
		const candidate = await runtime.loadFrozenCandidate();
		if (!candidate || !validCandidate(candidate)) return deny("trusted frozen candidate unavailable or invalid");
		if (candidate.head !== head || candidate.tree !== tree || candidate.branch !== branch
			|| candidate.indexTree !== indexTree || digest(status) !== candidate.statusDigest) return deny("Git HEAD, tree, branch, or index differs from the frozen candidate");
		if (!(await runtime.isCandidateCurrent(candidate))) return deny("frozen source or verification inputs are stale");
		if (branch !== request.branch || !branch.startsWith(grant.branchPrefix)) return deny("branch does not match the explicit task grant");
		const target = await runtime.resolveTarget(pushUrls[0] ?? "", branch);
		if (!target || target.instance !== grant.instance || target.project !== grant.project || target.protected
			|| !HASH.test(target.remoteHead)) return deny("confirmed project or branch protection identity unavailable or mismatched");
		const ancestor = await git(cwd, ["merge-base", "--is-ancestor", target.remoteHead, head]).then(() => true, () => false);
		if (!ancestor) return deny("remote branch is not an ancestor of the frozen candidate");
		const { commits, blobs } = await outgoingObjects(cwd, target.remoteHead, head);
		if (commits.length === 0 || commits.length > grant.maxCommits) return deny("outgoing commit count exceeds the explicit grant");
		const sortedCommits = [...commits].sort();
		const objectSetDigest = digest({ commits: sortedCommits, blobs });
		const candidateFingerprint = digest({
			cwd, branch, head, tree, indexTree, statusDigest: candidate.statusDigest,
			inputDigest: candidate.inputDigest, instance: target.instance, project: target.project,
			pushUrl: pushUrls[0], remoteHead: target.remoteHead, commits: sortedCommits, blobs,
		});
		const scanRequest: PublicationScanRequest = { candidateFingerprint, commitIds: sortedCommits, blobIds: blobs, objectSetDigest };
		const scan = await runtime.scan(scanRequest);
		if (!scan || !scan.passed || scan.scannerId !== grant.scannerId || scan.candidateFingerprint !== candidateFingerprint
			|| scan.objectSetDigest !== objectSetDigest || !sameIds(scan.commitIds, sortedCommits) || !sameIds(scan.blobIds, blobs)) {
			return deny("approved scanner did not attest the exact outgoing commit and blob sets");
		}
		const [headAfter, treeAfter, branchAfter, indexAfter, statusAfter, branchRefAfter, pushUrlsAfterOutput] = await Promise.all([
			git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["rev-parse", "HEAD^{tree}"]),
			git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]), git(cwd, ["write-tree"]),
			git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
			git(cwd, ["rev-parse", `refs/heads/${branch}`]),
			git(cwd, ["remote", "get-url", "--push", "--all", request.remote]),
		]);
		const pushUrlsAfter = pushUrlsAfterOutput.split("\n").filter(Boolean);
		const targetAfter = await runtime.resolveTarget(pushUrls[0] ?? "", branch);
		if (!(await runtime.isCandidateCurrent(candidate)) || headAfter !== head || treeAfter !== tree || branchAfter !== branch
			|| indexAfter !== indexTree || statusAfter !== status || branchRefAfter !== head || !sameIds(pushUrlsAfter, pushUrls) || !targetAfter
			|| targetAfter.remoteHead !== target.remoteHead || targetAfter.instance !== target.instance
			|| targetAfter.project !== target.project || targetAfter.protected !== target.protected) {
			return deny("frozen candidate, remote ref, or protection identity changed during authorization");
		}
		return { allowed: true, candidateFingerprint, commitIds: sortedCommits, blobIds: blobs, scannerId: scan.scannerId };
	} catch {
		return deny("Git state or trusted publication adapter unavailable");
	}
}
