---
description: Execute a task autonomously with proportional planning
argument-hint: "[task]"
---
Take over this task in the current Pi session: `${@:-the current request}`.

Act as the tech lead. Ask only about real blockers, authorization, or material scope changes. Skip planning for clearly bounded work; when planning is needed, create a durable plan with the `durable-plan` skill before implementation. Execute the work and give brief, non-blocking progress updates for each coherent non-trivial slice.

Use the Pi `subagent` tool only when delegation is useful; choose an exact agent from the roster and keep delegated scopes disjoint. Do not stop for routine choices.
