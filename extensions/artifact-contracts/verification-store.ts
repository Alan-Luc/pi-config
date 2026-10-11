import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type CandidateIdentity = Readonly<{
	id: string;
	repositoryRoot: string;
	head: string | null;
	tree: string;
	kind: "clean" | "dirty";
}>;

export type VerificationEvidence = Readonly<{
	id: string;
	command: string;
	argv: readonly string[];
	cwd: string;
	candidate: CandidateIdentity;
	exitCode: number;
	logPath: string;
	logSha256: string;
	valid: boolean;
	invalidReason?: string;
}>;

type CandidateInput = Omit<CandidateIdentity, "id">;
type EvidenceInput = Omit<VerificationEvidence, "id" | "argv"> & { argv: readonly string[] };
type VerificationClaim = Readonly<{ evidenceId: string; command: string; exitCode: number }>;
type VerificationAttempt = Readonly<{ token: symbol; generation: number }>;

const evidenceById = new Map<string, VerificationEvidence>();
const evidenceGenerationById = new Map<string, number>();
const latestByCommand = new Map<string, string>();
const latestAttemptByCommand = new Map<string, VerificationAttempt>();
let currentGeneration = 0;
let latestInvalidationReason = "tool activity after verification";

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function commandKey(command: string, cwd: string): string {
	return JSON.stringify([command, cwd]);
}

export function createCandidateIdentity(input: CandidateInput): CandidateIdentity {
	return Object.freeze({
		...input,
		id: `candidate_${hash(JSON.stringify([input.repositoryRoot, input.head, input.tree, input.kind]))}`,
	});
}

export function beginVerificationAttempt(command: string, cwd: string): VerificationAttempt {
	const key = commandKey(command, cwd);
	const attempt = Object.freeze({ token: Symbol(key), generation: currentGeneration });
	latestAttemptByCommand.set(key, attempt);
	return attempt;
}

export function recordVerificationEvidence(input: EvidenceInput, attempt?: VerificationAttempt): VerificationEvidence {
	const id = `verify_${hash(JSON.stringify([input.command, input.cwd, input.candidate.id, input.exitCode, input.logSha256]))}`;
	const generation = attempt?.generation ?? currentGeneration;
	const invalidatedDuringAttempt = generation !== currentGeneration;
	const { argv, valid: inputValid, invalidReason: inputInvalidReason, ...fields } = input;
	const valid = inputValid && !invalidatedDuringAttempt;
	const invalidReason = inputInvalidReason ?? (invalidatedDuringAttempt ? `tool activity overlapped verification: ${latestInvalidationReason}` : undefined);
	const evidence = Object.freeze({
		...fields,
		valid,
		...(invalidReason === undefined ? {} : { invalidReason }),
		id,
		argv: Object.freeze([...argv]),
	});
	evidenceById.set(id, evidence);
	evidenceGenerationById.set(id, generation);
	const key = commandKey(input.command, input.cwd);
	if (attempt === undefined) {
		latestByCommand.set(key, id);
	} else if (latestAttemptByCommand.get(key) === attempt) {
		latestByCommand.set(key, id);
		latestAttemptByCommand.delete(key);
	}
	return evidence;
}

export function verificationClaimErrors(claim: VerificationClaim): string[] {
	const evidence = evidenceById.get(claim.evidenceId);
	if (!evidence) return [`Verified by: evidence ${claim.evidenceId} was not found in this session`];

	const errors: string[] = [];
	if (claim.command !== evidence.command) errors.push(`Verified by: reported command does not match evidence ${claim.evidenceId}`);
	if (claim.exitCode !== evidence.exitCode) {
		errors.push(`Verified by: reported exit ${claim.exitCode}, evidence recorded ${evidence.exitCode}`);
	}
	const key = commandKey(evidence.command, evidence.cwd);
	if (latestAttemptByCommand.has(key)) {
		errors.push(`Verified by: evidence ${claim.evidenceId} is obsolete; a newer attempt for the command and cwd did not complete`);
	} else if (latestByCommand.get(key) !== evidence.id) {
		errors.push(`Verified by: evidence ${claim.evidenceId} is obsolete; only the latest result for the command and cwd is reportable`);
	}
	if (evidenceGenerationById.get(evidence.id) !== currentGeneration) {
		errors.push(`Verified by: evidence ${claim.evidenceId} is stale: ${latestInvalidationReason}`);
	}
	if (!evidence.valid) errors.push(`Verified by: evidence ${claim.evidenceId} is invalid: ${evidence.invalidReason ?? "verification failed"}`);

	try {
		if (hash(readFileSync(evidence.logPath)) !== evidence.logSha256) {
			errors.push(`Verified by: evidence ${claim.evidenceId} log hash does not match`);
		}
	} catch {
		errors.push(`Verified by: evidence ${claim.evidenceId} log is missing or unreadable`);
	}
	return errors;
}

export function invalidateVerificationEvidence(reason: string): void {
	currentGeneration += 1;
	latestInvalidationReason = reason;
}

export function clearVerificationEvidence(): void {
	evidenceById.clear();
	evidenceGenerationById.clear();
	latestByCommand.clear();
	latestAttemptByCommand.clear();
	currentGeneration = 0;
	latestInvalidationReason = "tool activity after verification";
}
