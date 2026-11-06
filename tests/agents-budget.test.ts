import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "bun:test";

const agentsMd = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
const techLeadMd = readFileSync(new URL("../extensions/tech-lead/tech-lead.md", import.meta.url), "utf8");

const words = (text: string) => text.trim().split(/\s+/).length;

// Every agent reads AGENTS.md; the CDC additionally reads tech-lead.md.
const AGENTS_WORD_BUDGET = 991;
const CDC_STARTUP_WORD_BUDGET = 1677;
const PROHIBITION_CAP = 13;

test("AGENTS.md stays within its word budget", () => {
	const count = words(agentsMd);
	assert.ok(count <= AGENTS_WORD_BUDGET, `AGENTS.md is ${count} words, budget ${AGENTS_WORD_BUDGET}`);
});

test("CDC startup (AGENTS.md + tech-lead.md) stays within its word budget", () => {
	const total = words(agentsMd) + words(techLeadMd);
	assert.ok(total <= CDC_STARTUP_WORD_BUDGET, `CDC startup is ${total} words, budget ${CDC_STARTUP_WORD_BUDGET}`);
});

test("AGENTS.md keeps prohibition words under cap", () => {
	const count = (agentsMd.match(/\b(never|do not|don't|avoid)\b/gi) ?? []).length;
	assert.ok(count <= PROHIBITION_CAP, `${count} prohibition words, cap ${PROHIBITION_CAP}`);
});
