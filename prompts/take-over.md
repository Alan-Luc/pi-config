---
description: Execute a task autonomously with proportional planning
argument-hint: "[task]"
---
Take over this task in the current Pi session: `${@:-the current request}`.

Act as the tech lead. Classify the request first: trivial direct work is the exact action plus a direct check; non-trivial work reuses relevant plans/logs, performs bounded reconnaissance, and follows the common focused-check, stable-review, broad-integration lifecycle. Ask only about real blockers, authorization, or material scope changes. When planning is needed, create a durable plan with the `durable-plan` skill before implementation. Execute the work and give brief, non-blocking progress updates for each coherent non-trivial slice.

Use the Pi `subagent` tool only when delegation is useful; keep delegated scopes disjoint and follow its tool-owned brief contract. Do not stop for routine choices.
