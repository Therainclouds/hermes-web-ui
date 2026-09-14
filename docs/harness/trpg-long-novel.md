# TRPG long-form novels

`long_novel` is a fourth writing mode. Existing `literary`, `documentary` and
`journal` generations still use their original chat + MCP path and limits.

## User flow

Choose **Long-form novel** in the TRPG chronicle section, select a target of
10,000/20,000/40,000/60,000 Chinese characters and an optional chapter hint
(2–24). The target is advisory: short source material produces a warning rather
than invented plot. Automatic chapter count is bounded by available scenes.

This mode always snapshots **all currently available finalized sentences**,
regardless of the recent/selected ASR scope used by other modes. Later recording
does not change an existing job. The panel shows sentence and character counts;
users should wait for final ASR/diarization if they want the entire recording.
Public `appearance` is included, but character-card text, private background,
portraits and API keys are not copied into the novel snapshot.

Start returns a durable job ID. Closing the tab does not cancel it. The panel
polls progress every five seconds; reopening loads existing jobs. Cancel stops
the current bridge session, retaining checkpoints. After server restart,
unfinished jobs appear interrupted and **Resume from checkpoint** restarts them.
Resuming after cancellation is explicit. A completed ID does not regenerate.

## Pipeline and evidence

1. `novel-material.ts` splits the immutable snapshot into non-overlapping owned
   ranges (about 5,500 estimated tokens / at most 120 utterances). Two neighbouring
   utterances on either side are supplied as context, never owned twice. Large
   individual utterances stay intact; excessive input fails instead of truncating.
2. Every extraction must partition its entire owned range exactly once into story
   and table-talk segments. Missing/overlapping ranges or out-of-range dialogue
   references fail validation. Material stores scene facts, original dialogue
   indices, rolling factual memory and explicit corrections with source/target
   ranges. Original ASR is retained for every later scene.
3. Story segments are grouped chronologically into chapters. Each chapter receives
   a title and guide; the full book title uses these plans. Table talk is processed
   but does not become prose. No-story input fails visibly.
4. Each scene gets its original rows, public roster, chapter guide, applicable
   later corrections **and their original evidence**, prior scene continuity and
   a short prose tail. Writing and review are separate bounded model calls.
   The review must account for every extracted dialogue reference. It fixes
   attribution, attempted-vs-confirmed actions and continuity while preserving
   literary detail. Ambiguities remain review notes.
5. Scene output and review are saved independently. Chapter files are assembled
   deterministically, then the final recap is published through existing validated
   Markdown persistence. There is no last whole-book rewrite that can compress
   the result back into a summary. Old-mode bodies still have the 1,800-character
   limit; pipeline-produced long chapters can contain up to 80,000 characters.

Each bridge call uses a fresh session with the selected profile's existing runtime
and credentials. No new provider configuration or fallback endpoint is guessed.
Context estimation uses `cl100k_base`, not the provider's exact tokenizer; an
estimated 28,000-token call ceiling fails visibly and retains earlier work. Model
context/output capabilities can still be smaller and must be checked operationally.
The pipeline instructions disallow tools and unrelated tasks; this uses the
existing profile bridge, not a new tool-isolated model executor.

One structural-repair attempt uses the same full input, never a shortened excerpt.
Operational failures stop for explicit resume. Total call attempts are persisted;
provider token/currency billing is not available from this adapter. A model call
completed just before a crash but before its checkpoint is written can repeat on
resume; this is at-least-once execution, not exactly-once billing.

Coverage here means every input range received a structurally valid extraction.
It does **not** prove perfect ASR, speaker attribution or semantic recall. The
writer/reviewer still needs evaluation against manually annotated real long runs.
Rolling memory is bounded; distant corrections may require human review. Chapter
grouping preserves order but currently balances scene count, not a global dramatic
arc optimizer. Cross-session canon, ASR correction editing, chapter editing and
distributed workers are outside this implementation.

## Storage and recovery

All paths resolve through `meetingDir()` → `getWebUiHome()`:

```text
meetings/<meetingId>/recap-requests/<requestId>.json
meetings/<meetingId>/novel-jobs/<requestId>/
  job.json
  extract-<index>.json
  plan-<index>.json
  book.json
  write-<index>.json
  review-<index>.json
  chapter-<index>.json
```

Step files contain schema/prompt version, input SHA-256, time and validated
output. Files are atomically renamed. Resume checks snapshot/version/input hashes
and revalidates checkpoints before using them. A saved step with stale progress
is reused without another model call. Changed inputs are rejected; create a new
snapshot for a new edition. Jobs and APIs enforce the same profile access as recaps.

The worker map/gates assume one backend process per Web UI state directory, as
the existing recap store does. Do not share the directory across worker processes.
Cancelled/failed job artifacts are retained for recovery; deleting a final recap
does not remove its source or checkpoints. No automatic retention deletion occurs.

API base: `/api/meeting-storage/:meetingId/novel-jobs`:

- `GET /`: profile-filtered metadata only (no transcript or chapter bodies).
- `POST /` with `{requestId}`: idempotently start a prepared long-novel snapshot.
- `GET /:jobId`: status, stage, source/scene coverage, call count and notes.
- `POST /:jobId/resume` and `POST /:jobId/cancel`: control that job.

The ordinary MCP `recap_save` cannot bypass this pipeline for long-novel snapshots.

## Validation

```sh
npm run test -- tests/server/trpg-novel.test.ts tests/server/trpg-recap.test.ts tests/client/trpg-novel.test.ts tests/client/trpg-recap.test.ts
npm run test:e2e -- tests/e2e/trpg-novel.spec.ts
npm run harness:check
npm run build
```

Tests use model and HTTP mocks. No real model usage is charged during validation.

## Writing Harness (2026-09-11)

This extension supersedes the earlier exclusions of chapter editing and manual
review. It reuses the durable worker; it does not introduce LangGraph or another
queue runtime. The implementation draws on:

- [Re3](https://aclanthology.org/2022.emnlp-main.296/): structured planning,
  recurrent state context and revision, rather than one long completion.
- [DOC](https://aclanthology.org/2023.acl-long.190/): detailed outlines and
  passage-level control to keep prose relevant to the planned story.
- [Dynamic hierarchical outlining with memory](https://aclanthology.org/2025.naacl-long.63/)
  and [STORYTELLER](https://aclanthology.org/2025.findings-acl.1071/): explicit
  narrative entity/state memory. This implementation uses a small evidence-backed
  entity/attribute ledger, not a graph database.
- [LangGraph interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)
  and [time travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel):
  durable human review gates and invalidating dependent work after an edit.

### Evidence and consistency contracts

The updated pipeline is:

```text
immutable full ASR → complete story/table-talk partition
 → per-scene event ledger + omissions + entity state updates
 → chapter outlines → optional outline approval
 → scene draft → source-based revision → independent consistency audit
 → chapter assembly → optional chapter approval → final novel
```

`novel-consistency.ts` implements the contracts:

- Every story-row index must occur in an event citation or an explicit omission
  record. Repeated speech may consolidate into one event; filler, ordering food,
  jokes and irrelevant rule discussion carry reasons for exclusion. Rule discussion
  that changes the fictional outcome must remain an event. Whole table-talk ranges
  remain accessible in the extraction artifact and original snapshot.
- Event kinds distinguish attempted actions, confirmed outcomes, dialogue,
  discoveries and corrections. Code assigns stable scene/event IDs; quotations
  must literally occur in the cited ASR row. Applicable later GM corrections and
  their original evidence are supplied before drafting earlier scenes.
- Canonical entity/attribute updates track location, health, inventory, knowledge,
  relationships, appearance, goals and world facts. Same-attribute duplicate
  updates are rejected. Code carries unchanged state forward, and builds the
  before/after state from source-derived updates, never from writer memory.
- The entire ledger remains reconstructible from saved canon steps. Each call
  retrieves party members, explicitly mentioned entities, updated entities and
  world facts, instead of blindly appending the entire history or silently
  truncating it. Names/aliases still depend on model resolution; a graph/semantic
  retriever for obscure aliases is not implemented.
- Every event must receive an audit coverage entry with an exact quotation from
  the actual manuscript. The audit checks causal/temporal order, speaker identity,
  attempted-vs-confirmed actions, knowledge boundaries, state changes, omissions,
  invented plot and repetitive padding. A report with issues is persisted with
  `passed: false`, stops the job with `novel_consistency_failed`, and prevents
  chapter progression/publication. Review its report, adjust direction/model,
  choose **Regenerate from this chapter**, then resume. Merely resuming retains
  the failed report; it does not silently waive the quality gate.

Code proves partition/citation/coverage structure, durable dependencies and gate
behavior. It cannot prove that a quote supports the model's interpretation, that
ASR is accurate, or that a reviewer detected every semantic conflict. The UI
states this distinction. Real six-hour annotated-campaign evaluation has not been
performed; current tests use mocked models, including long/multi-block fixtures.
There is no claim of perfect consistency or fixed monetary cost.

### Inspect and intervene

The job row links to `recap-book.html?workspace=novel&meetingId=…&jobId=…&profile=…`.
The standalone workbench displays chapter navigation, outlines, drafts beside
revisions, readable event ledgers, omission reasons, audit reports, original ASR,
artifact history, active model and recent activity. Metadata polls every 2.5s;
unchanged artifact bodies are cached server-side and only selected content is
fetched by the browser. Completed-step results appear as they checkpoint; this
is not token-by-token streaming of an unfinished call.

**Pause** lets the current model call finish and checkpoint before another call
starts. **Cancel** aborts it. Settings/outline edits require a stopped worker and
an exact `controls.revision`; a per-job gate serializes changes and resumes.
Dirty browser forms survive polling and warn before navigation. Outline/chapter
approval and resume are separate, explicit actions.

Chapter controls include title, required beats, POV, pacing, emphasis, exclusions
and an optional character target. Saving a chapter or requesting regeneration
increments its epoch and every later chapter's epoch, clears downstream approvals,
and makes the job resumable. Earlier source extraction, canon and unaffected
chapters stay cached. Superseded artifacts move to `history/<name>-<inputHash>.json`;
old published books remain readable until successful replacement. A model change
alone affects pending/retried calls; use regeneration to replace saved prose.

`controls.json`, `layout.json`, `events.json`, `canon-N.json`, `check-N.json` and
`history/` join the existing job/step files under `getWebUiHome()`. Profile checks
also apply to evidence/history reads. Artifact paths and version hashes are
whitelisted. Events are bounded to 200, UI warnings to 50, and metadata cache to
4096 entries. Raw model traces and credentials are not exposed by the workbench.
The worker remains single-process, with at-least-once paid calls across a crash.

### Model settings for all modes

The TRPG panel persists `Campaign.writingSettings` in its existing profile/user/
meeting-local browser storage. `defaultModel` applies to literary, documentary,
journal and long novel. Long novels additionally accept extract/plan/write/review
routes and review-gate preferences. Extract includes the canon pass; review
includes the independent audit. Identities only (`provider`, `model`) cross the
API; credentials continue to come from the profile. Stage settings override the
default, then fall back to the profile. Routes go into bridge/session options,
not just prompt text. Workbench edits are scoped to the selected running job;
the panel's settings are defaults for future jobs and other writing modes.

### Validation and real-campaign acceptance

Focused suites: `trpg-novel`, `trpg-novel-consistency`, `trpg-novel-model`,
`trpg-writing-settings`, `trpg-recap`, `trpg-plugin`; browser flows in
`tests/e2e/trpg-novel.spec.ts` and `trpg-recap-book.spec.ts`; production build and
`harness:check`. Tests cover unsupported quotations, missing source/event coverage,
state carry-forward, late correction evidence, model routing, revisions, pause,
review gates, suffix invalidation and version reads.

Before tuning a provider for production, use a consented real 5–6h recording with
manually labelled key events, character aliases, GM corrections and table talk.
Measure key-event recall, attribution errors, attempted/confirmed confusion,
state/knowledge contradictions, unsupported plot, filler/repetition, and human
revision time per chapter. Compare extraction and reviewer routes on the same
immutable snapshot. Never use word count or a self-reported `passed` rate alone
as the acceptance metric. If an input exceeds the bounded model context budget,
the job stops visibly without dropping ASR; earlier checkpoints remain available.

## Recovery, bounded planning and visual direction (2026-09-13)

A reported 2605-row job had already completed all 35 extraction blocks. The
failure was in a later `canon-N` step; scene counters were initialized too late,
which misleadingly displayed 0/0 scenes. The old attempt loop discarded concrete
validator errors and retried only once. Failed raw output was not retained, so
its exact invalid field cannot be reconstructed retrospectively.

The worker now reports scene/ledger progress before planning and persists the
failed step, attempt and bounded validation detail. Each step allows four total
attempts, preserving strict validation. Repairs receive the concrete error and
previous output only when it fits the context budget. Known transient model
failures use bounded abortable backoff. Invalid checkpoints are revalidated and
rebuilt; good source checkpoints retain their original prompt/input hashes.

Audit reports may honestly report missing events without inventing nonexistent
prose quotations: incomplete coverage is permitted only in a **failed** report.
Passing still requires every event and a real manuscript quotation. One automatic
prose revision consumes audit findings and then undergoes the same audit gate;
persistent issues stop the job and remain inspectable. Earlier versions are
archived. Neither retry nor repair can waive the consistency gate.

Independent chapter plans use the previous chapter's immutable source facts,
rather than waiting for its generated plan. `writing.concurrency` selects 1–4
planning calls (default 2). Results retain chronological order. Active tasks
are drained before a job fails/pauses; durable job and event writes are serialized.
Canonical state updates and scene write/review/audit progression remain sequential.
This accelerates planning, not the entire state-dependent pipeline. There is no
claim that a six-hour run becomes four times faster.

In the embedded highlights tab, **Use photo notes for writing** matches an image's
ASR to the selected chapter and fills its direction with the image prompt/manual
visual description and original quotations. Pause first, inspect/edit the notes,
then save the chapter direction. Up to six references are allowed; the server
checks every quote against the immutable snapshot and chapter range. Only matching
scene references reach prose generation. References can influence lighting,
atmosphere and publicly established appearance, not canon facts or outcomes.
This path does not perform automatic pixel understanding. The existing
post-generation upload-as-illustration action remains available.

The workbench now uses a paper-toned manuscript pane, dark controls, active-step
and attempt chips, detailed errors and visible early ledger artifacts. Cloning
saved Vue reactive chapter directions unwraps the proxy first, preventing the
previous post-save DataCloneError banner. Browser tests assert no alert after
saving/resuming and capture a workbench screenshot for visual inspection.

Verification includes the original job copied into an isolated temporary home:
35 extraction blocks and the 15 completed canon artifacts in that copy were reused;
the first mocked model call was `canon-15` (143 scenes), with no real model call or
mutation of the user's job. New tests cover bounded parallelism, worker draining,
automatic structural/semantic repairs, strict failed/passed coverage, visual
reference validation and the highlight-to-direction UI handoff.

### Visual-model association (follow-up)

The image-present **Association analysis** path now performs real image
understanding; this supersedes the earlier prompt-only association limitation.
`POST …/novel-jobs/:jobId/visual-match` verifies profile/job ownership, decodes and
normalizes uploaded PNG/JPEG/WebP bytes with a pixel limit, and sends a genuine
multimodal `image_url` message through the existing profile bridge. No client URL
or file path is fetched. The new `vision` model route covers both image analysis
and association; users must select a model that accepts images.

First, image-only analysis returns visible details, search anchors and uncertainty
without seeing the possibly misleading generation prompt. Character identity and
fictional outcomes are not inferred from pixels. Next, local bigram retrieval
scores **all** ASR scenes using visual anchors plus prompt/transcript hints and
supplies six candidate scenes to a second model call. Candidates contain bounded
source rows and relevant paragraphs from saved revised prose. This is retrieval,
not an exhaustive semantic comparison of every sentence; the UI reports candidate
and total scene counts. Scores are model relevance estimates, not calibrated
probabilities. No reliable match is a valid empty result.

Up to three recommendations must reference actual candidate ASR quotations;
optional manuscript quotations must occur in the supplied paragraph. Chapter and
scene IDs are resolved from server-owned layout, never accepted as model authority.
The UI shows image observations, uncertainty, match reasons, original quotations,
and chapter selection. A passage link opens the exact saved manuscript fingerprint
and highlights the corresponding paragraph; current and archived fingerprints both
resolve. ASR-only links open the original scene even before its prose exists.
Users can then apply the selected visual description and evidence to chapter
direction, with the existing pause/revision/canon checks still enforced. A cached
analysis is reused for applying within the page only while the image/prompt/source
are unchanged; it is not silently reused for a changed picture.

Stage planning and layout now become inspectable before sequential canon building
finishes. Scene/state chronology, final consistency gates and source provenance
remain unchanged. Tests use generated tiny image fixtures and mocked visual models;
no live provider or real user image was submitted during automated validation.

### September 13: consistency-first scheduling and historical citations

Context-dependent reading, canon construction and scene writing run sequentially, regardless of the concurrency setting. Only independent chapter plans fan out. Earlier candidate read/material/state artifacts remain inspectable but are no longer execution dependencies. Valid extract/canon checkpoints retain their original prompt/input fingerprints.

State updates may cite prior state evidence, resolved against the immutable transcript; current scene event coverage cannot use this historical-only evidence. Duplicate omissions and mixed event/filler classifications normalize with event evidence taking precedence. Index-only citations resolve through supplied immutable rows; unknown indices and fabricated quotations still fail. Repair feedback includes permitted indices and supports index-only output, avoiding quotation transcription errors. Retries remain bounded and persistent semantic failures still block publication.

The writing panel accepts a 5,000–60,000 total-character target. Changing it pauses the job and invalidates chapter prose epochs, preserving source and factual checkpoints; chapter-specific targets take precedence. Targets remain approximate and short output produces a warning.

### Missing-row repair and illustration provenance

A structurally valid canon with uncovered ASR rows now triggers a bounded, separately checkpointed gap-classification call. The validated base is retained; the model receives the missing rows and scene context and returns additional events, explicit omissions and state updates. Code merges and revalidates full coverage. Temporary placeholders are never published, and unclear source text is never silently classified as filler. Regression tests cover missing narrative evidence and an omission-only patch.

Visual matches return available canon/extraction artifact fingerprints alongside ASR and prose evidence. The workbench links to these exact versions, and retains the analysis in the campaign record for later illustration work. Stored analysis is restored only when job, prompt, transcript and image bytes match; applying it to writing still requires a fresh in-session analysis after reopening. Picture evidence remains subordinate to the immutable transcript.

### Opt-in economy mode and cumulative usage

`WritingSettings.economy` is available in both chronicle settings and the novel direction panel. Novel economy mode retains source coverage, sequential canon/state, writer context, dialogue coverage, independent semantic audits and repair/recheck gates. It removes only exactly recoverable duplicate source quotation copies from requests. It tries the initial draft directly at the audit gate instead of always generating a second full manuscript. A failed audit still requires repair and a passing recheck. Locally accepted review artifacts are marked `audit-first`; ordinary mode will not mistake those for model-reviewed checkpoints. Target length is unchanged. A passing first draft saves one of the three usual scene prose calls; overall time/token savings depend on source size, repairs and models.

Chronicle chat mode keeps full snapshot reading but requests concise process output and a saved-result link instead of repeating the saved manuscript in chat. This is prompt-level guidance; the novel executor enforces its own economy path in code.

Both novel modes persist cumulative input/output token counters in job.json, counting retries and excluding reused checkpoints. Final bridge input_tokens/output_tokens are used when available; otherwise text-token estimates are explicitly labelled. Failed calls with unknown output and older untracked calls are disclosed, so the UI does not present a partial estimate as billing usage. Counts concern novel pipeline calls; separate image association calls and external chat sessions are not included.

### Chapter planning context overflow

A 143-scene job grouped roughly 20–21 scenes per chapter. Passing every event's full quotations plus preceding-chapter material exceeded the 28,000-token adapter limit. Planning now passes event IDs, kinds, facts and scene locations, retaining detailed evidence exclusively in the durable canon consumed by writing and audit. Requests are partitioned under a 16,000-token input budget; oversized chapters get ordered partial plans followed by a bounded synthesis. Every event enters a partial plan; the final plan is an index, not a replacement for canonical facts. Oversized book-title inputs use the same reducer. Existing valid legacy chapter plans, extracts and canons remain reusable.

The context-budget error is no longer labelled as a generic model failure. Calls rejected by this preflight do not accrue estimated token usage. Historical estimates cannot be reconstructed precisely.

Read-only testing with the reported fifth chapter measured approximately 37,232 tokens for its prior material payload (excluding instructions). The bounded planning test kept new payloads below 16,000, using mock summaries and no paid model call. Synthetic regression tests verify ordered event coverage, request bounds and rejection instead of silent truncation.

### September 14: durable paragraph repair, audit contracts and length budgets

Scene review now writes a separate `revision-state-N.json`, keyed by source-derived input, initial draft and chapter epoch. It retains the latest revised body before invoking the audit. Resume uses that checkpoint rather than regenerating the first review after a later revision changed its artifact hash. Each `revision-N-R` contains a paragraph patch; code replaces only addressed paragraphs and validates the result. An unchanged patch is rejected. After passing audit, the accepted body is mirrored to `review-N` with old versions archived for existing reader/illustration links. Up to four content repairs run automatically per worker invocation; persistent failures preserve the latest revision instead of restarting prose.

Audits support numbered paragraphs whose text is resolved by code. Exact duplicate claims deduplicate; unknown IDs, conflicting duplicate claims and invalid paragraph references request a report-only retry (up to two), not prose regeneration. Missing event support is a failed audit with explicit issues. A substring recovered by discarding part of a model's claim is not treated as proof, nor does a source quote accidentally appearing in prose prove semantic coverage.

The former 500-character per-scene minimum made a 143-scene / 10,000-character request mathematically impossible. Global target now apportions exact integer scene budgets with no fixed minimum inflation. Chapter targets act as relative weights within the global budget. Whitespace is excluded and Unicode code points counted. Each scene is checked against its allocated ±10% range and corrected via paragraph patches; publication also requires the complete text within the global ±10% range. Impossible per-scene storage budgets are reported rather than silently capped or dropping facts.

The existing Hermes Agent Bridge continues to execute model stages. Extra uncontrolled agents would not remove sequential dependencies. Performance improvements here remove repeated draft/review work, preserve independent bounded chapter planning, compact recoverable duplicate evidence in both modes, and use concise paragraph references for audits. No claim of real-recording speedup is made without a complete model run.

Workbench adds categorized artifact buttons, persistent light/dark themes, optional following of latest saved output, and a separate unverified live JSON preview. Only structured output streams or final responses are previewed; non-JSON reasoning preambles are excluded. In-memory preview payloads are bounded to four steps / 12,000 characters per step and remain under existing profile checks. When the backend only returns a final response the preview cannot appear earlier than that response.
