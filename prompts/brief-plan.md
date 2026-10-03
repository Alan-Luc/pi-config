---
description: Create a concise durable plan and wait for approval
argument-hint: "[objective]"
---
Use the `durable-plan` skill for: `${@:-the current request}`.

Act as the planning lead in this main Pi session. Perform only bounded, read-only discovery and produce the shortest complete durable plan. Present a clean plan review in chat; do not edit or implement.

Wait for exactly one of: `Continue planning`, `Approve — Build`, or `Approve — Tech Lead`.
