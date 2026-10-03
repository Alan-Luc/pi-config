---
description: Explore a repository and build a disposable proof of concept
argument-hint: "[hypothesis]"
---
Run a local exploratory spike for: `${@:-the current hypothesis}`.

This is not production implementation. Define an observable success criterion before editing, ask one focused question if the request lacks enough information, then explore the local repository and build the smallest runnable PoC. Stop when the criterion passes or a concrete blocker proves it cannot. Run the smallest relevant local check.

Do not commit, push, alter production data, call production or external APIs, add infrastructure, or clean unrelated code. Return findings, changed paths, checks and actual results, prototype limitations, remaining unknowns, and clearly identify disposable code.
