# Live-verification narrative

Use this companion when existing live evidence can demonstrate the changed path in an MR description.
Keep the skill's `Summary` and `How to observe/verification` sections.
Put the evidence sequence under `How to observe/verification`.
For proposals or missing evidence, give expected behavior without implying execution.

## Select the proof

Read the relevant artifacts before writing.
Reuse [live-verification](../../live-verification/SKILL.md) for execution and identity checks when verification is requested.
This companion presents evidence; it does not authorize new runs, instrumentation, service access, or uploads.

Choose the smallest sequence connecting the user's action to the changed path and its observable result.
A passing test summary alone does not establish which path ran.
Preparation logs alone do not prove later consumption.
For multi-step behavior, show the observations connecting the relevant boundaries.
For a simple CLI change, the actual command and resulting file or output may suffice.

## Show it in action

1. Name the runtime or test environment and distinguish real services from mocked boundaries.
2. Show actual commands beside their important observed outputs.
3. Separate evidence by producer, such as service logs, HTTP observations, framework reports, and CLI output.
4. Repeat exact relevant identifiers across blocks so readers can check that the observations belong together.
5. Explain what those observations prove in plain language.
6. State relevant limitations, persisted side effects, and source-preservation observations.

Preserve executed commands, including flags that later proved redundant.
Label verbatim excerpts, selected fields, shortened reports, and plain-text renderings of structured logs distinctly.
Preserve values and meaning when removing logging envelopes or irrelevant fields.
Do not present observer output or report fields as native service logs.
Do not invent log lines, identifiers, successful steps, or missing links.
Keep enough matching identifier text visible to establish equality without opening another artifact.

Put the decisive evidence inline instead of making reviewers reconstruct the path from links.
Link supporting artifacts only when the MR audience can access them.
Do not present local filesystem paths as hosted attachments.
Exclude secrets and sensitive content.
If safe redaction removes a decisive link, narrow the claim and disclose the limit.

Distinguish observed results from expected behavior and inferred conclusions.
Report missing relevant proof as `Not run: <reason>` or identify the unproven boundary.
Retain relevant failed attempts when they explain a prerequisite, substitution, or changed runtime identity.
Do not imply that synthetic checks or mocked boundaries prove full integration.

## Illustrative shape

These values are fictional examples, not evidence to reuse.
Select blocks for the feature rather than requiring this layout or these identifiers.

````markdown
### How to observe/verification

Ran the local service with real test storage and search. Notifications were mocked.

**CLI output** — verbatim excerpt:

```text
$ app import articles.yaml
Imported 3 articles. Copy: copy-42
```

**Service log** — one structured entry rendered as plain text:

```text
Copy ready
copy_id=copy-42
index_id=articles-copy-42
```

**HTTP observer** — selected fields:

```text
index_id=articles-copy-42
request_id=req-17
status=200
```

**Framework result** — selected fields from the JSON report:

```text
request_id=req-17
retrieved_title=Cancellation policy
```

The search targeted the prepared copy's index.
The matching request ID connects that search to the retrieved article.

The test copy remains in test storage. Notification delivery was not verified.
````
