type BranchEntry = Readonly<{ id: string; type: string; message?: Readonly<{ role: string }> }>;
type SessionManager = Readonly<{
	getSessionId(): string;
	getBranch(): readonly BranchEntry[];
}>;
export type AssignmentSnapshot = Readonly<{
	sessionId: string;
	requestEntryId: string;
	branchEntryIds: readonly string[];
}>;

export function currentAssignment(sessionManager: SessionManager): AssignmentSnapshot | undefined {
	const branch = sessionManager.getBranch();
	let requestEntryId: string | undefined;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		requestEntryId = entry.id;
		break;
	}
	if (!requestEntryId) return undefined;
	return Object.freeze({
		sessionId: sessionManager.getSessionId(),
		requestEntryId,
		branchEntryIds: Object.freeze(branch.map((entry) => entry.id)),
	});
}

function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
	return prefix.length <= path.length && prefix.every((entryId, index) => path[index] === entryId);
}

export function sameAssignment(previous: AssignmentSnapshot, current: AssignmentSnapshot): boolean {
	return previous.sessionId === current.sessionId
		&& previous.requestEntryId === current.requestEntryId
		&& isPrefix(previous.branchEntryIds, current.branchEntryIds);
}
