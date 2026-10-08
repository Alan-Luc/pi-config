import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
	EditToolCallEvent,
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { renderTemplate } from "./render.ts";
import { matchPath, validate } from "./validate.ts";

export type ExactEdit = { readonly oldText: string; readonly newText: string };

export type ExactEditResult =
	| { readonly ok: true; readonly content: string }
	| { readonly ok: false; readonly error: string };

export type DocumentWriteInput = {
	readonly relPath: string;
	readonly exists: boolean;
	readonly current?: string;
	readonly proposed: string;
};

export type DocumentWriteResult = { readonly block: false } | { readonly block: true; readonly reason: string };

type Match = { readonly start: number; readonly end: number; readonly edit: number; readonly newText: string };
type ResolvedPath = { readonly absolutePath: string; readonly relPath: string };
type CurrentFile = { readonly exists: false } | { readonly exists: true; readonly current?: string; readonly error?: string };

function normalizeLf(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

function findMatches(text: string, needle: string): number[] {
	const matches: number[] = [];
	for (let index = text.indexOf(needle); index >= 0; index = text.indexOf(needle, index + 1)) {
		matches.push(index);
	}
	return matches;
}

export function applyExactEdits(current: string, edits: readonly ExactEdit[]): ExactEditResult {
	const content = normalizeLf(current);
	const matches: Match[] = [];

	for (let index = 0; index < edits.length; index++) {
		const oldText = normalizeLf(edits[index].oldText);
		const newText = normalizeLf(edits[index].newText);
		if (oldText.length === 0) {
			return { ok: false, error: `edit ${index + 1}: oldText must be non-empty` };
		}

		const positions = findMatches(content, oldText);
		if (positions.length === 0) {
			return { ok: false, error: `edit ${index + 1}: oldText was not found exactly` };
		}
		if (positions.length > 1) {
			return {
				ok: false,
				error: `edit ${index + 1}: oldText must match exactly once; found ${positions.length} matches`,
			};
		}
		matches.push({ start: positions[0], end: positions[0] + oldText.length, edit: index + 1, newText });
	}

	const ordered = [...matches].sort((left, right) => left.start - right.start);
	for (let index = 1; index < ordered.length; index++) {
		if (ordered[index].start < ordered[index - 1].end) {
			return {
				ok: false,
				error: `edits ${ordered[index - 1].edit} and ${ordered[index].edit} overlap`,
			};
		}
	}

	let result = content;
	for (const edit of [...ordered].reverse()) {
		result = `${result.slice(0, edit.start)}${edit.newText}${result.slice(edit.end)}`;
	}
	return { ok: true, content: result };
}

function templateReason(schema: Parameters<typeof renderTemplate>[0], errors: readonly string[]): string {
	return `${errors.join("\n")}\n\nTemplate:\n${renderTemplate(schema)}`;
}

function createOnlyReason(operation: "write" | "edit"): string {
	return operation === "write"
		? "Handoff documents are create-only: an existing handoff cannot be overwritten."
		: "Handoff documents are create-only: edits are not allowed.";
}

export function checkDocumentWrite({ relPath, exists, current, proposed }: DocumentWriteInput): DocumentWriteResult {
	const match = matchPath(relPath);
	if (!match) return { block: false };
	if (match.kind === "protected") return { block: true, reason: match.reason };
	if (match.createOnly && exists) return { block: true, reason: createOnlyReason("write") };
	if (exists && current === undefined) {
		return {
			block: true,
			reason: templateReason(match.schema, [`cannot validate existing document ${JSON.stringify(relPath)} without its current content`]),
		};
	}

	const result = validate(match.schema, proposed, exists ? current : undefined);
	return result.ok ? { block: false } : { block: true, reason: templateReason(match.schema, result.errors) };
}

function expandLeadingTilde(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
	return path;
}

function resolvePath(cwd: string, requestedPath: string): ResolvedPath | undefined {
	const absoluteCwd = resolve(cwd);
	const normalizedInput = requestedPath.replaceAll("\\", "/");
	const absolutePath = resolve(absoluteCwd, expandLeadingTilde(normalizedInput));
	const relativePath = relative(absoluteCwd, absolutePath);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		isAbsolute(relativePath)
	) {
		return undefined;
	}
	return { absolutePath, relPath: relativePath.replaceAll("\\", "/") };
}

function rejectSymlinkComponents(absolutePath: string, cwd: string, relPath: string): string | undefined {
	const boundary = resolve(cwd);
	const relativePath = relative(boundary, absolutePath);
	if (
		relativePath.length === 0 ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		isAbsolute(relativePath)
	) {
		return `Cannot verify protected document path ${JSON.stringify(relPath)}: resolved path is outside trusted cwd ${JSON.stringify(boundary)}.`;
	}

	for (let current = absolutePath; ; current = dirname(current)) {
		try {
			if (lstatSync(current).isSymbolicLink()) {
				return `Blocked protected document path ${JSON.stringify(relPath)}: symlink component ${JSON.stringify(current)} is not allowed.`;
			}
		} catch (error: unknown) {
			const missing = typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			if (!missing) {
				const detail = error instanceof Error ? error.message : String(error);
				return `Cannot inspect protected document path ${JSON.stringify(relPath)} at ${JSON.stringify(current)}: ${detail}`;
			}
		}
		if (current === boundary) return undefined;
	}
}

function readCurrentFile(absolutePath: string): CurrentFile {
	if (!existsSync(absolutePath)) return { exists: false };
	try {
		return { exists: true, current: readFileSync(absolutePath, "utf8") };
	} catch (error: unknown) {
		return { exists: true, error: error instanceof Error ? error.message : String(error) };
	}
}

function unreadableReason(schema: Parameters<typeof renderTemplate>[0], relPath: string, error: string): ToolCallEventResult {
	return {
		block: true,
		reason: templateReason(schema, [`cannot read existing document ${JSON.stringify(relPath)}: ${error}`]),
	};
}

function exactEditReason(error: string): ToolCallEventResult {
	return {
		block: true,
		reason: `${error}\n\nRetry with exact, unique oldText matching the current file.`,
	};
}

function missingEditReason(relPath: string): ToolCallEventResult {
	return { block: true, reason: `Cannot edit missing document ${JSON.stringify(relPath)}.` };
}

function isWriteEvent(event: ToolCallEvent): event is WriteToolCallEvent {
	return event.toolName === "write";
}

function isEditEvent(event: ToolCallEvent): event is EditToolCallEvent {
	return event.toolName === "edit";
}

function handleDocumentToolCall(event: ToolCallEvent, ctx: Pick<ExtensionContext, "cwd">): ToolCallEventResult | undefined {
	if (!isWriteEvent(event) && !isEditEvent(event)) return undefined;

	const resolved = resolvePath(ctx.cwd, event.input.path);
	if (!resolved) return undefined;

	const classification = matchPath(resolved.relPath);
	if (!classification) return undefined;
	if (classification.kind === "protected") return { block: true, reason: classification.reason };
	const symlinkReason = rejectSymlinkComponents(resolved.absolutePath, ctx.cwd, resolved.relPath);
	if (symlinkReason !== undefined) return { block: true, reason: symlinkReason };
	if (isEditEvent(event) && classification.createOnly) return { block: true, reason: createOnlyReason("edit") };

	const currentFile = readCurrentFile(resolved.absolutePath);
	if (currentFile.exists && currentFile.error !== undefined) {
		return unreadableReason(classification.schema, resolved.relPath, currentFile.error);
	}
	const current = currentFile.exists ? currentFile.current : undefined;

	let proposed: string;
	if (isEditEvent(event)) {
		if (!currentFile.exists) return missingEditReason(resolved.relPath);
		const applied = applyExactEdits(currentFile.current ?? "", event.input.edits);
		if (!applied.ok) return exactEditReason(applied.error);
		proposed = applied.content;
	} else {
		proposed = event.input.content;
	}

	const result = checkDocumentWrite({
		relPath: resolved.relPath,
		exists: currentFile.exists,
		current,
		proposed,
	});
	return result.block ? result : undefined;
}

export function registerDocumentHooks(pi: ExtensionAPI): void {
	pi.on("tool_call", handleDocumentToolCall);
}
