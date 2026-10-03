// No index.ts here, so Pi does not load this directory as an extension.

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches pi-subagents' canonical child-launch marker semantics. */
export function isSubagentChildEnvironment(
	env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
	return ["PI_SUBAGENT_AGENT", "PI_SUBAGENT_PARENT_SESSION", "PI_SUBAGENT_NAME", "PI_SUBAGENT_SESSION", "PI_SUBAGENT_SURFACE"].some(
		(key) => Boolean(env[key]?.trim()),
	);
}
