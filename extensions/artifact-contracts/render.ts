import { SCHEMAS, type SchemaId } from "./schemas.ts";

export function renderTemplate(schemaId: SchemaId): string {
	const schema = SCHEMAS[schemaId];
	return [
		...schema.preamble.map((line) => line.example),
		...(schema.preamble.length ? [""] : []),
		...schema.sections.flatMap((section) => [`## ${section.heading}`, `<!-- fill: ${section.hint} -->`, ""]),
	].join("\n");
}

/** Appends to the system prompt without replacing it; the prior value may be unset. */
export function appendInstructions(options: { appendSystemPrompt?: string }, text: string): void {
	options.appendSystemPrompt = options.appendSystemPrompt ? `${options.appendSystemPrompt}\n\n${text}` : text;
}
