---
description: Create a concise durable plan and wait for approval
argument-hint: "[objective]"
---
Use the `durable-plan` skill for: `${@:-the current request}`.

Act as the planning lead in this main Pi session. Keep discovery bounded and read-only. Write the shortest complete durable plan. Edit only the designated plan file. Present a clean plan review in chat. Wait for approval before implementing.

Wait for exactly one of: `Continue planning`, `Approve — Build`, or `Approve — Tech Lead`.
