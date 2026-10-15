import { DOCUMENTS, FREEFORM, PROTECTED, SCHEMAS, type Schema, type SchemaId, type Section } from "./schemas.ts";

export type ValidationResult = { ok: boolean; errors: string[] };

export type PathMatch =
	| { kind: "document"; schema: SchemaId; createOnly: boolean }
	| { kind: "freeform" }
	| { kind: "protected"; reason: string }
	| null;

type Fence = { char: "`" | "~"; length: number; line: number };
type BodyLine = { index: number; line: number; text: string };
type SectionOccurrence = {
	heading: string;
	raw: string;
	index: number;
	line: number;
	end: number;
	body: BodyLine[];
	rawBody: string;
};
type ParsedDocument = {
	lines: string[];
	fenced: boolean[];
	sections: SectionOccurrence[];
	unclosedFenceLine?: number;
};

type PatternLike = { readonly pattern: RegExp; readonly example: string };

const FILL_MARKER = "<!-- fill";
const ITEM_START = /^( {0,3})(?:- |\d+\. )/;

function quote(value: string): string {
	return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Markdown treats up to three leading spaces as column 0; four or more make indented code. */
function unindent(line: string): string {
	return line.replace(/^ {1,3}(?! )/, "");
}

/** The text a Markdown renderer treats as structure. */
function structural(line: string): string {
	return unindent(line).trimEnd();
}

function matches(pattern: PatternLike, value: string): boolean {
	pattern.pattern.lastIndex = 0;
	const result = pattern.pattern.test(value);
	pattern.pattern.lastIndex = 0;
	return result;
}

function fenceMarker(line: string): { char: "`" | "~"; length: number; rest: string } | undefined {
	const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) return undefined;
	return {
		char: match[1][0] === "`" ? "`" : "~",
		length: match[1].length,
		rest: match[2],
	};
}

function parse(text: string): ParsedDocument {
	const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
	const fenced = new Array<boolean>(lines.length).fill(false);
	const headings: Array<Omit<SectionOccurrence, "end" | "body" | "rawBody">> = [];
	let fence: Fence | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		const marker = fenceMarker(line);
		if (fence) {
			fenced[index] = true;
			if (
				marker &&
				marker.char === fence.char &&
				marker.length >= fence.length &&
				marker.rest.trim().length === 0
			) {
				fence = undefined;
			}
			continue;
		}
		if (marker) {
			fenced[index] = true;
			fence = { char: marker.char, length: marker.length, line: index + 1 };
			continue;
		}
		const text = unindent(line);
		if (text.startsWith("## ")) {
			headings.push({ heading: text.slice(3).trim(), raw: line, index, line: index + 1 });
		}
	}

	const sections = headings.map((heading, index) => {
		const end = headings[index + 1]?.index ?? lines.length;
		return {
			...heading,
			end,
			body: lines.slice(heading.index + 1, end).flatMap((text, offset) =>
				text.trim() ? [{ index: heading.index + 1 + offset, line: heading.line + 1 + offset, text }] : [],
			),
			rawBody: lines.slice(heading.index + 1, end).join("\n"),
		};
	});
	return { lines, fenced, sections, unclosedFenceLine: fence?.line };
}

export function sectionBody(text: string, heading: string): string | undefined {
	return parse(text).sections.find((section) => section.heading === heading)?.rawBody;
}

function validatePreamble(schema: Schema, document: ParsedDocument, errors: string[]): void {
	const firstSection = document.sections[0]?.index ?? document.lines.length;
	const nonBlank = document.lines.slice(0, firstSection).flatMap((text, index) =>
		text.trim() ? [{ index, line: index + 1, text }] : [],
	);
	for (let index = 0; index < Math.max(nonBlank.length, schema.preamble.length); index++) {
		const expected = schema.preamble[index];
		const actual = nonBlank[index];
		if (!actual) errors.push(`missing preamble ${quote(expected.example)}`);
		else if (!expected) errors.push(`line ${actual.line}: unexpected preamble line ${quote(actual.text)}`);
		else {
			const text = structural(actual.text);
			if (!matches(expected, text)) {
				errors.push(
					text === expected.example
						? `line ${actual.line}: replace placeholder ${quote(expected.example)}`
						: `line ${actual.line}: expected preamble ${quote(expected.example)}, found ${quote(actual.text)}`,
				);
			}
		}
	}
}

function validateItems(section: Section, body: BodyLine[], errors: string[]): void {
	const definition = section.item;
	if (!definition) return;
	if (section.none && body.length === 1 && structural(body[0].text) === "None.") return;

	type Item = { lines: BodyLine[] };
	const items: Item[] = [];
	let current: Item | undefined;
	let base: number | undefined;
	for (const line of body) {
		const marker = ITEM_START.exec(line.text);
		const indent = line.text.length - line.text.trimStart().length;
		if (marker && (base === undefined || marker[1].length <= base)) {
			base ??= marker[1].length;
			current = { lines: [line] };
			items.push(current);
		} else if (current && base !== undefined && indent > base) {
			current.lines.push(line);
		} else {
			errors.push(`line ${line.line}: expected a top-level item, found ${quote(line.text)}`);
		}
	}

	for (const item of items) {
		const first = item.lines[0];
		if (!matches(definition, structural(first.text))) {
			errors.push(
				`line ${first.line}: expected item matching ${quote(definition.example)}, found ${quote(first.text)}`,
			);
		}
		if (!definition.labels) continue;

		const text = item.lines.map((line) => line.text).join("\n");
		let searchFrom = 0;
		for (const label of definition.labels) {
			const found = text.indexOf(label, searchFrom);
			if (found >= 0) {
				searchFrom = found + label.length;
				continue;
			}
			const earlier = text.indexOf(label);
			const line = earlier >= 0 ? item.lines[Math.min(text.slice(0, earlier).split("\n").length - 1, item.lines.length - 1)].line : first.line;
			const problem = earlier >= 0 ? "out of order" : "missing";
			errors.push(`line ${line}: item label ${quote(label)} is ${problem}`);
		}
	}
}

function validateOneOf(section: Section, body: BodyLine[], errors: string[], headingLine: number): void {
	if (!section.oneOf) return;
	const expected = section.oneOf.map(quote).join(", ");
	if (body.length !== 1) {
		errors.push(`line ${headingLine}: expected exactly one non-blank line, found ${body.length}; expected one of ${expected}`);
		return;
	}
	if (!section.oneOf.includes(structural(body[0].text))) {
		errors.push(`line ${body[0].line}: expected one of ${expected}, found ${quote(body[0].text)}`);
	}
}

function validateLines(section: Section, body: BodyLine[], errors: string[], headingLine: number): void {
	if (!section.lines) return;
	if (body.length !== section.lines.length) {
		errors.push(`line ${headingLine}: expected exactly ${section.lines.length} non-blank lines, found ${body.length}`);
	}
	for (const [index, line] of body.entries()) {
		const expected = section.lines[index];
		if (expected && !matches(expected, structural(line.text))) {
			errors.push(`line ${line.line}: expected line matching ${quote(expected.example)}, found ${quote(line.text)}`);
		}
	}
}

function validateSubheadings(
	section: Section,
	document: ParsedDocument,
	occurrence: SectionOccurrence,
	errors: string[],
): void {
	if (!section.subheading) return;
	for (let index = occurrence.index + 1; index < occurrence.end; index++) {
		const line = document.lines[index];
		const text = structural(line);
		if (!document.fenced[index] && text.startsWith("### ") && !matches(section.subheading, text)) {
			errors.push(
				`line ${index + 1}: expected subheading matching ${quote(section.subheading.example)}, found ${quote(line)}`,
			);
		}
	}
}

function validateBody(
	section: Section,
	document: ParsedDocument,
	occurrence: SectionOccurrence,
	errors: string[],
): void {
	const body = occurrence.body;
	if (body.length === 0) {
		errors.push(`line ${occurrence.line}: section ${quote(`## ${section.heading}`)} must have a non-blank body`);
		return;
	}
	if (body.some((line) => hasFillMarker(document, line.index))) return;

	validateOneOf(section, body, errors, occurrence.line);
	validateLines(section, body, errors, occurrence.line);
	validateItems(section, body, errors);
	validateSubheadings(section, document, occurrence, errors);
}

function validateAppendOnly(
	document: ParsedDocument,
	previous: string,
	section: Section,
	occurrence: SectionOccurrence,
	errors: string[],
): void {
	if (!section.appendOnly) return;
	const previousDocument = parse(previous);
	const previousSection = previousDocument.sections.find((candidate) => candidate.heading === section.heading);
	if (!previousSection) return;
	const oldBody = previousSection.rawBody.trimEnd();
	const newBody = occurrence.rawBody.trimEnd();
	if (!newBody.startsWith(oldBody)) {
		errors.push(`line ${occurrence.line}: append-only section ${quote(`## ${section.heading}`)} was changed before its previous body`);
	}
}

function validateStructure(schema: Schema, document: ParsedDocument, errors: string[]): void {
	const definitions = new Map(schema.sections.map((section) => [section.heading, section]));
	const occurrences = new Map<string, SectionOccurrence[]>();
	const firstOccurrences: SectionOccurrence[] = [];

	for (const occurrence of document.sections) {
		const section = definitions.get(occurrence.heading);
		if (!section) {
			errors.push(`line ${occurrence.line}: unexpected section ${quote(occurrence.raw)}`);
			continue;
		}
		const matching = occurrences.get(section.heading);
		if (matching) matching.push(occurrence);
		else {
			occurrences.set(section.heading, [occurrence]);
			firstOccurrences.push(occurrence);
		}
	}

	for (const section of schema.sections) {
		const matching = occurrences.get(section.heading) ?? [];
		if (matching.length === 0) errors.push(`missing section ${quote(`## ${section.heading}`)}`);
		else for (const duplicate of matching.slice(1)) {
			errors.push(`line ${duplicate.line}: duplicate section ${quote(`## ${section.heading}`)}`);
		}
	}

	const expectedOrder = schema.sections.filter((section) => occurrences.has(section.heading));
	for (let index = 0; index < firstOccurrences.length; index++) {
		const actual = firstOccurrences[index];
		const expected = expectedOrder[index];
		if (expected && actual.heading !== expected.heading) {
			errors.push(
				`line ${actual.line}: section ${quote(actual.raw)} is out of order; expected ${quote(`## ${expected.heading}`)}`,
			);
		}
	}

	for (const section of schema.sections) {
		for (const occurrence of occurrences.get(section.heading) ?? []) {
			validateBody(section, document, occurrence, errors);
		}
	}
}

function validateTopLevelH1(document: ParsedDocument, errors: string[]): void {
	const firstSection = document.sections[0]?.index ?? document.lines.length;
	for (let index = firstSection; index < document.lines.length; index++) {
		if (!document.fenced[index] && unindent(document.lines[index]).startsWith("# ")) {
			errors.push(`line ${index + 1}: unexpected heading ${quote(document.lines[index])}`);
		}
	}
}

/** Code may quote the marker; only a marker outside code means an unfilled template. */
function outsideCode(document: ParsedDocument, index: number): string {
	return document.fenced[index] ? "" : document.lines[index].replace(/(`+).*?\1/g, "");
}

function hasFillMarker(document: ParsedDocument, index: number): boolean {
	return outsideCode(document, index).includes(FILL_MARKER);
}

function sectionHasFillMarker(document: ParsedDocument, occurrence: SectionOccurrence): boolean {
	for (let index = occurrence.index + 1; index < occurrence.end; index++) {
		if (hasFillMarker(document, index)) return true;
	}
	return false;
}

/** A literal `\uXXXX` outside code means an escape was typed instead of the character. */
function validateLineContent(document: ParsedDocument, errors: string[]): void {
	const fillErrors: string[] = [];
	const escapeErrors: string[] = [];
	for (let index = 0; index < document.lines.length; index++) {
		const text = outsideCode(document, index);
		for (let start = text.indexOf(FILL_MARKER); start >= 0; start = text.indexOf(FILL_MARKER, start + FILL_MARKER.length)) {
			fillErrors.push(`line ${index + 1}: fill marker is not allowed`);
		}
		for (const match of text.matchAll(/\\u[0-9a-fA-F]{4}/g)) {
			escapeErrors.push(`line ${index + 1}: literal escape ${quote(match[0])}; type the character itself`);
		}
	}
	errors.push(...fillErrors, ...escapeErrors);
}

export function validate(schemaId: SchemaId, text: string, previous?: string): ValidationResult {
	const schema = SCHEMAS[schemaId] as Schema | undefined;
	if (!schema) return { ok: false, errors: [`unknown schema ${quote(String(schemaId))}`] };

	const document = parse(text);
	const errors: string[] = [];
	if (document.unclosedFenceLine !== undefined) {
		errors.push(`line ${document.unclosedFenceLine}: unclosed fenced code block`);
	}
	validateLineContent(document, errors);
	validatePreamble(schema, document, errors);
	validateTopLevelH1(document, errors);
	validateStructure(schema, document, errors);

	if (previous !== undefined) {
		for (const section of schema.sections) {
			if (!section.appendOnly) continue;
			for (const occurrence of document.sections.filter((candidate) => candidate.heading === section.heading)) {
				if (!sectionHasFillMarker(document, occurrence)) {
					validateAppendOnly(document, previous, section, occurrence, errors);
				}
			}
		}
	}

	return { ok: errors.length === 0, errors };
}

export function matchPath(relPath: string): PathMatch {
	for (const protectedPath of PROTECTED) {
		if (matches({ pattern: protectedPath.path, example: "" }, relPath)) {
			return { kind: "protected", reason: protectedPath.reason };
		}
	}
	for (const document of DOCUMENTS) {
		if (matches({ pattern: document.path, example: "" }, relPath)) {
			return { kind: "document", schema: document.schema, createOnly: document.createOnly };
		}
	}
	for (const path of FREEFORM) {
		if (matches({ pattern: path, example: "" }, relPath)) return { kind: "freeform" };
	}
	return null;
}
