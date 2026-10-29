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
	branchPrefix: "alan/ENG-";
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

export type AdvertisedPublicationRef = { ref: string; sha: string };
export type PublicationBranchState = { state: "existing"; head: string } | { state: "absent" };
export type PublicationTarget = {
	instance: string;
	project: string;
	protected: boolean;
	branchState: PublicationBranchState;
	advertisedRefs: readonly AdvertisedPublicationRef[];
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
		&& grant.branchPrefix === "alan/ENG-"
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
		&& request.branch.startsWith("alan/ENG-") && request.branch.length > "alan/ENG-".length;
}

async function configValues(cwd: string, key: string): Promise<string[]> {
	try {
		const output = await git(cwd, ["config", "--null", "--get-all", key]);
		return output.split("\0").slice(0, -1);
	} catch (error) {
		if (isRecord(error) && error.code === 1) return [];
		throw error;
	}
}

async function submodulePublicationEnabled(cwd: string): Promise<boolean> {
	const pushModes = await configValues(cwd, "push.recurseSubmodules");
	if (pushModes.length > 0) return !["no", "check"].includes(pushModes[pushModes.length - 1] ?? "");
	try {
		const value = await git(cwd, ["config", "--type=bool", "--get", "submodule.recurse"]);
		if (value !== "true" && value !== "false") throw new Error("invalid submodule.recurse value");
		return value === "true";
	} catch (error) {
		if (isRecord(error) && error.code === 1) return false;
		throw error;
	}
}

async function followTagsEnabled(cwd: string): Promise<boolean> {
	try {
		const value = await git(cwd, ["config", "--type=bool", "--get", "push.followTags"]);
		if (value !== "true" && value !== "false") throw new Error("invalid push.followTags value");
		return value === "true";
	} catch (error) {
		if (isRecord(error) && error.code === 1) return false;
		throw error;
	}
}

async function outgoingObjects(cwd: string, advertisedRefs: readonly AdvertisedPublicationRef[], head: string): Promise<{ commits: string[]; blobs: string[] }> {
	if (!HASH.test(head) || advertisedRefs.some(({ ref, sha }) => !ref.startsWith("refs/") || !HASH.test(sha))) throw new Error("invalid advertised object identity");
	const available: string[] = [];
	for (const { sha } of advertisedRefs) {
		if (await git(cwd, ["cat-file", "-e", `${sha}^{commit}`]).then(() => true, () => false)) available.push(sha);
	}
	const args = ["rev-list", "--reverse", head, ...(available.length ? ["--not", ...available] : [])];
	const commitsOutput = await git(cwd, args);
	const commits = commitsOutput ? commitsOutput.split("\n") : [];
	const objectArgs = ["rev-list", "--objects", "--no-object-names", head, ...(available.length ? ["--not", ...available] : [])];
	const objectsOutput = await git(cwd, objectArgs);
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
		await git(cwd, ["check-ref-format", "--branch", request.branch]);
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
		if (await followTagsEnabled(cwd)) return deny("effective push.followTags could publish unscanned annotated tags");
		const [pushMappings, recurseSubmodules] = await Promise.all([
			configValues(cwd, "remote.origin.push"), submodulePublicationEnabled(cwd),
		]);
		if (pushMappings.length > 0) return deny("configured remote.origin.push could retarget the publication destination");
		if (recurseSubmodules) return deny("effective submodule recursion could publish unscanned objects");
		const candidate = await runtime.loadFrozenCandidate();
		if (!candidate || !validCandidate(candidate)) return deny("trusted frozen candidate unavailable or invalid");
		if (candidate.head !== head || candidate.tree !== tree || candidate.branch !== branch
			|| candidate.indexTree !== indexTree || digest(status) !== candidate.statusDigest) return deny("Git HEAD, tree, branch, or index differs from the frozen candidate");
		if (!(await runtime.isCandidateCurrent(candidate))) return deny("frozen source or verification inputs are stale");
		if (branch !== request.branch || !branch.startsWith(grant.branchPrefix)) return deny("branch does not match the explicit task grant");
		const target = await runtime.resolveTarget(pushUrls[0] ?? "", branch);
		if (!target || target.instance !== grant.instance || target.project !== grant.project || target.protected
			|| !Array.isArray(target.advertisedRefs)
			|| target.advertisedRefs.some(({ ref, sha }, index) => !ref.startsWith("refs/") || !HASH.test(sha)
				|| (index > 0 && target.advertisedRefs[index - 1]!.ref >= ref))) return deny("confirmed project or branch protection identity unavailable or mismatched");
		const remoteRef = `refs/heads/${branch}`;
		const advertisedBranch = target.advertisedRefs.find(({ ref }) => ref === remoteRef);
		if (target.branchState.state === "existing") {
			if (!HASH.test(target.branchState.head) || advertisedBranch?.sha !== target.branchState.head) return deny("confirmed remote branch state is inconsistent");
			const ancestor = await git(cwd, ["merge-base", "--is-ancestor", target.branchState.head, head]).then(() => true, () => false);
			if (!ancestor) return deny("remote branch is not an ancestor of the frozen candidate");
		} else if (target.branchState.state !== "absent" || advertisedBranch) return deny("confirmed remote branch state is inconsistent");
		const { commits, blobs } = await outgoingObjects(cwd, target.advertisedRefs, head);
		if (commits.length === 0) return deny("no outgoing task commits");
		if (commits.length > grant.maxCommits) return deny("outgoing commit count exceeds the explicit grant");
		const sortedCommits = [...commits].sort();
		const objectSetDigest = digest({ commits: sortedCommits, blobs });
		const candidateFingerprint = digest({
			cwd, branch, head, tree, indexTree, statusDigest: candidate.statusDigest,
			inputDigest: candidate.inputDigest, instance: target.instance, project: target.project,
			pushUrl: pushUrls[0], branchState: target.branchState, advertisedRefs: target.advertisedRefs, commits: sortedCommits, blobs,
		});
		const scanRequest: PublicationScanRequest = { candidateFingerprint, commitIds: sortedCommits, blobIds: blobs, objectSetDigest };
		const scan = await runtime.scan(scanRequest);
		if (!scan || !scan.passed || scan.scannerId !== grant.scannerId || scan.candidateFingerprint !== candidateFingerprint
			|| scan.objectSetDigest !== objectSetDigest || !sameIds(scan.commitIds, sortedCommits) || !sameIds(scan.blobIds, blobs)) {
			return deny("approved scanner did not attest the exact outgoing commit and blob sets");
		}
		const [headAfter, treeAfter, branchAfter, indexAfter, statusAfter, branchRefAfter, pushUrlsAfterOutput, followTagsAfter, pushMappingsAfter, recurseSubmodulesAfter] = await Promise.all([
			git(cwd, ["rev-parse", "HEAD"]), git(cwd, ["rev-parse", "HEAD^{tree}"]),
			git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]), git(cwd, ["write-tree"]),
			git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
			git(cwd, ["rev-parse", `refs/heads/${branch}`]),
			git(cwd, ["remote", "get-url", "--push", "--all", request.remote]),
			followTagsEnabled(cwd), configValues(cwd, "remote.origin.push"), submodulePublicationEnabled(cwd),
		]);
		const pushUrlsAfter = pushUrlsAfterOutput.split("\n").filter(Boolean);
		const targetAfter = await runtime.resolveTarget(pushUrls[0] ?? "", branch);
		if (followTagsAfter || pushMappingsAfter.length > 0 || recurseSubmodulesAfter !== recurseSubmodules
			|| JSON.stringify(pushMappingsAfter) !== JSON.stringify(pushMappings)
			|| !(await runtime.isCandidateCurrent(candidate)) || headAfter !== head || treeAfter !== tree || branchAfter !== branch
			|| indexAfter !== indexTree || statusAfter !== status || branchRefAfter !== head || !sameIds(pushUrlsAfter, pushUrls) || !targetAfter
			|| JSON.stringify(targetAfter.branchState) !== JSON.stringify(target.branchState)
			|| JSON.stringify(targetAfter.advertisedRefs) !== JSON.stringify(target.advertisedRefs)
			|| targetAfter.instance !== target.instance || targetAfter.project !== target.project || targetAfter.protected !== target.protected) {
			return deny("frozen candidate, remote ref, or protection identity changed during authorization");
		}
		return { allowed: true, candidateFingerprint, commitIds: sortedCommits, blobIds: blobs, scannerId: scan.scannerId };
	} catch {
		return deny("Git state or trusted publication adapter unavailable");
	}
}
