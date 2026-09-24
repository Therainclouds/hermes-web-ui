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
the existing recap store does. A durable per-job lease (`lease.json`) plus
startup reconcile make that assumption observable rather than implicit: a job
whose owner died is persisted as `interrupted`, and a second process that shares
the directory refuses to start, resume, edit or cancel a job with a live foreign
lease. Cancelled/failed job artifacts are retained for recovery; deleting a final
recap does not remove its source or checkpoints. No automatic retention deletion
occurs.

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

Context-dependent reading, canon construction, audits and commits run sequentially, regardless of the concurrency setting. Independent chapter plans and the initial drafts of upcoming scenes can run ahead; a draft that consumed changed facts is rebuilt (see the dependency fingerprints below). Earlier candidate read/material/state artifacts remain inspectable but are no longer execution dependencies. Valid extract/canon checkpoints retain their original prompt/input fingerprints.

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

Legacy jobs without revision-state checkpoints may seed recovery from their existing write/review artifacts only when version and chapter epochs match. This preserves prior prose across the migration while requiring fresh audit against current context. Explicit chapter regeneration/changed direction advances the epoch and cannot reuse this seed. A regression reproduces a legacy review hash overwritten by repair and verifies that resume performs only the audit call.

### September 14: patch coverage metadata and GM narration

A live failure reported `missing dialogue evidence coverage` even though the persisted semantic report had passed. Paragraph patches listing only changed-row coverage were replacing the whole manuscript's coverage metadata. Patch application now unions supplied indices with existing indices; these remain metadata, not proof of coverage, and full event/manuscript audit remains mandatory after changes.

GM attribution is retained in source, extraction, canon and audit evidence. Manuscript GM speaker labels trigger a targeted narrative-format issue: environmental narration and rulings become narrator prose, while identified NPC speech retains the NPC identity. Code-side narrative/length issues are now persisted in the report too, avoiding a misleading passed report while the worker is revising for length or narrative format.

### September 14: bounded editor agent and whole-book length balancing (supersedes per-scene gates above)

The 143-scene example exposed a contradictory acceptance contract: a 251-character scene
was simultaneously asked to preserve more details and compress a 1,194-character draft.
Scene allocations are now soft writing budgets. Only the assembled manuscript must meet
the user's total ±10%; titles/whitespace do not contribute. Factual acceptance remains
mandatory before publication. Optional literary suggestions have a separate nonblocking
report field; ambiguous ASR is not grounds for inventing a definite interpretation, and
GM roll suggestions must not become performed actions or successful outcomes.

`novel-editor-agent.ts` implements an application-level JSON tool protocol over the
existing model adapter, not unrestricted native Hermes tool access. The editor chooses
`read_evidence`, `read_paragraphs`, `patch_paragraphs`, or `report_conflict`. The server
executes bounded read-only retrieval against immutable supplied evidence and deterministic
paragraph replacement. It returns tool errors as observations. Sufficient evidence permits
an immediate patch without extra retrieval. Every patched manuscript requires a fresh
independent semantic audit; untouched paragraphs are preserved. Tool actions are saved
as inspectable artifacts. No private chain of thought is requested or displayed.

Each editing decision has at most eight tool turns (raised from six on September 14); a scene has at most three committed
repair rounds across resumes. Repeated identical unresolved issues or explicit constraint
conflicts persist a blocked revision state. Unchanged resume spends no more model tokens
on that scene; changing review model or chapter direction permits a new attempt. Invalid
report references trigger report repair, not a new manuscript. Original extract/canon
fingerprints are unchanged, retaining expensive source checkpoints for older jobs.

Only an out-of-range whole manuscript triggers the final length pass (at most two rounds).
Candidates must strictly improve distance to the total target, pass source/fact audit,
and pass an audit of the unchanged successor against the revised predecessor. Nonpassing
candidates are not committed. Accepted versions are archived, chapters reassembled, and
changed chapters require renewed approval when chapter approval is enabled. Round progress
and unresolved length conflicts are durable; unchanged resume does not restart two more
rounds. An impossible total remains blocked with saved prose rather than published outside
±10% or expanded with invented facts. This does not promise all model/source combinations
will satisfy mutually incompatible facts, style and size constraints.

Design references: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
(clear evaluation criteria, bounded feedback loops, tool-directed actions),
[Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
(durable progress and incremental verified work), and
[Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
(purpose-built tool interfaces and informative observations). Domain constraints and
sequential continuity commits remain server-owned. No uncontrolled parallel writer fleet
or measured real-campaign speedup is claimed. Validation uses mocked models and temporary
snapshots; the reported user's existing job is not rewritten by tests.

### September 14: scene-scoped review and deletable paragraphs

A live 98-scene job stalled at its second scene with `novel_revision_stalled` after three
editor rounds. The audit was correct: the review step had expanded a ~270-character draft
into a ~1,100-character scene containing a later scene's plot, taken from the chapter guide's
beat list, had duplicated a paragraph, and had misattributed one observation. Two of those
three issues required *removing* prose, but `patch_paragraphs` only documented replacement,
so the editor described the deletion in `continuity` without submitting it and the same
issues returned every round. Re-running the same scene then showed the second half of the
bug: the repair editor received the whole-chapter beat list and kept rewriting the other
scene's plot instead of deleting it, because the guide appeared to require it.

- `patch_paragraphs` edits now accept `delete: true` (or `text: ""`) to remove a paragraph.
  One call may delete several paragraphs by their original numbers; the whole patch is applied
  before any renumbering. Deleting the entire scene body and malformed `delete` flags are
  rejected.
- Audits, editor reads and patches share one paragraph split (`paragraphsOf`): trimmed, with
  whitespace-only paragraphs dropped. Previously the audit numbered a trimmed list while the
  editor patched the raw list, so one whitespace-only paragraph shifted every later index.
- The reviewer and the fact-repair editor are **scene-scoped**: `book` and `chapter.guide` are
  removed from their request (the reviewer keeps the scene's own `rows`; the editor reads
  evidence through its bounded tool protocol). The writer still receives the guide, so chapter
  style and pacing are established, but the guide can no longer act as a scene content
  contract. The review instruction and `EDITOR_PROMPT` both state the boundary explicitly:
  guide-listed material that `rows`/`canon.events` do not support is deleted as whole
  paragraphs, never rewritten or kept.
- `RULES` is deliberately left unchanged. It is part of every step's input hash, so editing it
  invalidates extraction/canon/plan checkpoints and forces an expensive full re-read on
  resume. Scene-boundary text lives in the write/review/editor instructions instead.
- `revisionPolicy()` fingerprints the writing/review/editor instructions and the audit
  contract into the revision and balance contexts. A harness fix therefore invalidates a
  stored blocked revision once and the scene is retried, instead of replaying the old block
  forever. Changing only the model still does not replace saved prose.
- A resumed stall reports the stored round count and up to three concrete remaining issues
  (and the success path clears a stale `job.failure`), so the workbench names what to change
  instead of only showing the generic stall sentence.

Verification used the reported job copied into an isolated temporary home, with a mocked
auditor/editor: the stored block was no longer replayed, one deletion-based editor call
accepted the previously blocked second scene, extraction/canon checkpoints were reused (no
re-read), and the original job directory was never mutated. Blocking semantics are unchanged:
publication still requires a passing independent audit, and genuinely contradictory
constraints still stop the job with the latest prose saved. Real six-hour annotated-campaign
evaluation remains pending.

### September 14: sticky source checkpoints and per-artifact reset

A resumed reported job re-read the transcript from block 0 (`已处理 0/2605`). `step()` keyed
its cache on the full prompt hash, so editing any instruction invalidated every saved artifact
— including the expensive extraction blocks and the fact ledger the user had already paid for.

- Extraction blocks (`extract-*`), fact ledgers (`canon-*`) and scene drafts (`write-*`) are
  now **sticky**: any valid saved artifact is reused regardless of the prompt/version hash, so
  resume generates only what is missing. A draft additionally compares its chapter epoch, so
  explicit chapter regeneration still rebuilds it. A checkpoint that fails its own validation
  is still rebuilt, and a changed snapshot is still rejected as `novel_source_changed`.
- Review, audit and repair steps stay hash-keyed. `revisionPolicy()` changes therefore still
  unblock a stalled scene, and every committed manuscript still gets a fresh independent audit.
- `POST …/novel-jobs/:jobId/artifacts/:artifact` with `{action:'delete'|'regenerate', revision}`
  removes one generated artifact (archived to `history/` first) and bumps `controls.revision`.
  `delete` leaves the job paused so the next resume rebuilds exactly that piece; `regenerate`
  resumes immediately. A completed job becomes resumable without unpublishing the old book,
  which stays readable until a successful replacement. Guards: 409 while a worker is active or
  on a stale revision, 400 for an unknown action/name, 404 for a missing artifact.
- The workbench artifact toolbar exposes **Delete artifact** and **Delete and regenerate**.
  Deletion does not cascade by hand: an artifact that consumed the removed one is
  rebuilt automatically when the replacement's content differs (see the
  dependency-fingerprint section below), so the old "delete dependents too"
  instruction no longer applies.

Verification reused the reported job in an isolated copy with a mocked auditor/editor: resume
made zero extraction, canon and planning calls, backfilled nothing, accepted the previously
blocked scene with one deletion-based editor call and three audits, and left the original job
directory untouched.

### September 14: whole-scene rewrite tool (editor convergence)

The next resumed run reached scene 3 and then failed with `编辑工具调用未收敛` after the editor
used all six tool turns. Every turn was a `patch_paragraphs` call that deleted *all* paragraphs
(`{paragraph:N, delete:true}` for the whole body) or rewrote paragraph 0 while deleting the rest
— the model's way of asking for a full-scene rewrite, which per-paragraph editing can never
apply: an all-delete patch produces an empty body and is refused, so the scene blocked at
revision 0 instead of converging.

- The editor protocol gained `replace_scene({body,covered?,continuity?,warnings?})` for audits
  whose findings span most of the manuscript. The body is validated like any draft (≤7k chars,
  prose paragraphs, no headings/HTML), `covered` must contain the scene's dialogue indices, and
  a fresh independent audit still runs afterwards — this is a way to express the edit, not a
  waiver. `patch_paragraphs` remains the tool for local changes.
- Non-empty `text` now wins over a `delete` flag on the same edit. Models routinely echo the
  replacement text together with `delete:true`; reading that as a deletion silently dropped
  intended prose. An edit with neither text nor `delete:true` is still rejected.
- `EDITOR_PROMPT` states both rules, including "never submit an all-delete patch to simulate a
  rewrite". Because `revisionPolicy()` includes `EDITOR_PROMPT`, a stored
  `novel_revision_stalled` block is invalidated once by this change and the scene is retried.
- `EDITOR_PROMPT` and the whole-scene path are also covered by the workbench artifact reset:
  deleting `revision-state-N` restarts the repair budget for that scene.

Verification on the reported job copy: the previously blocked scene accepted after the editor's
all-delete patch was refused once and a whole-scene rewrite applied, with zero extraction,
canon or planning calls; the original job directory was untouched.

### September 14: blocking contradictions vs advisory findings

The next run stalled again on the same scene. Its final report contained three findings — GM
labels, a duplicated paragraph, a missing source line — and none of them was a factual
contradiction. Worse, the three audits of that scene had flagged *different* sets each round
(the first rewrite's report did not mention GM labels at all; the last one did), so the editor
was chasing a moving blocking target. With one scene able to stop 98, a job could never finish.

The audit contract now separates what stops a job from what is merely reported:

- Every audit issue carries `kind`. `contradiction` = prose contradicts source/canon, invents
  unsupported plot, turns an attempt into a success, or misattributes a speaker — this is the
  **only** blocking kind. `omission` = a source event or line is missing while the prose stays
  faithful. `format` = GM/主持人 presentation, duplicated paragraphs, wording and pacing.
- `validateConsistency` returns both `passed` (a clean report, unchanged meaning) and
  `blocking` (at least one contradiction). Code-side missing coverage is an `omission`;
  malformed report claims stay `format` plus `repairReport`, so they still trigger report-only
  retries and can fail the step as `novel_invalid_output`.
- Unlabelled model issues keep defaulting to `contradiction`, so an older or careless audit
  cannot silently pass. The review/repair loop and the whole-book length pass gate on
  `blocking`; a scene with only advisory findings is accepted immediately, with no repair round.
- Accepted advisory findings are appended to `job.warnings` with their scene number, so the
  workbench shows what was shipped imperfectly instead of dropping it. The length pass no
  longer rejects a candidate for GM-label or omission warnings.
- `narratorIssues` (the scripted GM-label detector) is `format`, never blocking.

This is the deliberate answer to "is the consistency too strict": fabricated or contradictory
facts still stop publication, while a faithful-but-incomplete scene no longer blocks the book.
Real-campaign evaluation of how often each kind fires is still pending.

Verification on the reported job copy: with an auditor that reports exactly the live findings
(classified as two `format`, one `omission`), the previously blocked scene was accepted with
zero repair rounds, zero extraction/canon/planning calls, and the findings listed as warnings.

### September 14: the editor edits by quotation, not by paragraph arithmetic

Live editor turns showed why the model kept failing to *apply* a fix: it was asked to address
paragraph numbers it had to count itself. One turn sent 45 edits at a 34-paragraph body; others
sent `{paragraph: N, delete: true}` for every paragraph to express "rewrite the scene"; a third
echoed replacement text together with `delete: true`. Every one was refused, six turns were
spent, and the scene blocked at revision 0.

- `patch_paragraphs` now accepts **exact-excerpt edits**: `{find, replace}`. `find` must match
  the current manuscript verbatim and occur exactly once (≥ 4 characters); `replace: ""`
  deletes it; edits in one patch apply in order. Quoting text the model can see is its strong
  suit, and a unique match makes stale numbering and accidental whole-body deletion impossible.
- Paragraph edits stay available for numbered changes. Mixing the two shapes in one patch is
  rejected, as are missing, ambiguous, too-short or non-changing excerpts, each with a specific
  observation the editor can correct on its next turn.
- The editor budget rose from six to eight tool turns. `replace_scene` remains the verb for
  pervasive rewrites, so a full rewrite never has to be simulated with deletions.
- `EDITOR_PROMPT` documents the excerpt form first and includes a worked example.

The convergence limit is still the auditor: an LLM judge can re-describe the same defect
differently each round. That is why only `contradiction` findings block, while omissions and
presentation findings are advisory — the repair target stays finite and reachable.

Verification: excerpt replacement, deletion, rejection feedback and a full pipeline run that
fixes a contradiction with a single excerpt edit are covered by unit and integration tests.

### September 14: durable repair memory and continue-on-unresolved

The repair loop was memoryless across rounds: each round opened a fresh model session that saw
only the current manuscript and the newest audit report. It could therefore repeat a fix that
had already been rejected, or undo something an earlier round fixed, which is what produced the
oscillation ("fix A, break B, fix B, break A").

- `revision-state-N.json` now carries `repairLog`. Each round records the blocking findings, the
  editor action (tool, kind and size), every rejected patch with its reason, and what the next
  audit still reported. The next round's editor input receives a compact `history` built from
  it, and `EDITOR_PROMPT` tells the editor not to repeat a proven-ineffective fix or undo a
  successful one.
- `runEditorAgent` returns `action` and `rejected` so the log is a truthful summary rather than
  a restatement of the request. The log survives resume because it is written with the same
  checkpoint as the draft.
- `WritingSettings.consistency` (`warn` by default, `block` optional) controls what happens when
  contradictions remain after the bounded repair rounds. `warn` records them as scene warnings
  in `job.warnings` and keeps writing, so one scene can no longer stop a 98-scene book; the
  workbench exposes it as **Stop on unresolved factual contradictions**. `block` keeps the old
  hard stop, including its resume-blocking checkpoint.
- The repair-loop no-progress guard compares only the blocking findings, so advisory rewordings
  cannot trigger it.
- `REVISION_POLICY` was bumped so any stored `novel_revision_stalled` block is invalidated once
  and the scene is retried under the new rules.

Honest limits: the audit is still an LLM. If it labels an omission as a contradiction, the
editor will try to fix it and `warn` mode records it if it cannot; `block` mode stops there.
The default is now the mode that lets a long book finish.

Verification: 246 TRPG unit tests, the three workbench e2e flows, `harness:check`, server and
client type checks. Memory contents, the warn-mode acceptance path and the strict block path
are each covered by tests.

### September 14: dependency-fingerprinted checkpoints, durable lease and context compaction

Four changes close the failure classes that the earlier sections only mitigated. They also make
the harness's loop explicit rather than implicit.

**1. The live `missing dialogue evidence coverage` stall.** A 98-scene job stopped at scene 8 with
`missing dialogue evidence coverage` after four attempts, and every resume repeated the four paid
review calls (13.7M cumulative tokens, 27 failed outputs with unknown size). The step validated
the review model's `covered` list against `scene.dialogueIndices`: a model had to restate a set of
source indices, and dropping any one failed the step with no actionable feedback. `invalid()`
received no detail, so the retry prompt could not name the missing indices. This is the same class
of defect as the paragraph-arithmetic stall already fixed for the editor: code can enumerate the
invariant, so asking the model to reproduce it is a design error.

- `validateDraft` accepts numeric-string indices (matching `citations()`), so a provider that
  serialises `["80","81"]` no longer has a correct list discarded.
- `withDialogueCoverage` unions `scene.dialogueIndices` into `covered` in code and returns the
  indices the model omitted. The review step, the editor `patch_paragraphs`/`replace_scene` path
  and the length pass all use it, so no path can hard-fail on this bookkeeping. Omissions are
  appended to `job.warnings`; they are metadata, **not** proof — the independent audit still runs
  and remains the semantic gate, exactly as patch coverage metadata was already demoted in the
  patch-union fix above.

**2. Durable blocked-step memory.** A step that exhausts its four attempts on an unchanged request
persists `blocked-<name>.json` keyed by the request, the model route and `revisionPolicy()`. The
next resume throws `novel_step_blocked` with the stored detail and makes **zero** model calls.
Changing the model route, chapter direction, harness policy or the artifact itself produces a
different key and lets a fresh attempt through; deleting the artifact also removes its blocked
record. Transient `novel_model_failed` is never blocked, so a provider outage still retries.

**3. Dependency-fingerprinted sticky checkpoints (supersedes "sticky regardless of hash").**
Sticky steps previously reused a valid artifact whenever its version and chapter epoch matched,
ignoring what the artifact had consumed. Deleting and regenerating `canon-5` with different
content therefore left `write-5` and later prose in place: a new ledger paired with old prose,
and with the default `consistency: 'warn'` the resulting audit finding became a warning instead of
a rebuild.

Each sticky step now records a `dependencyHash` — the step input without the instruction. Reuse
requires the epoch **and** that fingerprint to match, so:
- editing a prompt or the harness still reuses every paid source checkpoint (the original sticky
  promise, and why `RULES` remains untouched);
- changing the canon, rows, prior state or chapter plan an artifact consumed rebuilds it, and its
  own changed output rebuilds the artifacts downstream of it through their fingerprints;
- a legacy artifact without a fingerprint falls back to the full prompt hash, so an untouched old
  job still reuses everything and a changed one rebuilds once.

The write/review migration seed follows the same rule. Deleting one artifact now rebuilds exactly
what is missing or stale, which is why the workbench hint changed: dependents are no longer the
user's manual responsibility.

**4. Durable lease and startup reconcile.** Job lifecycle used to live in the in-process `active`
map: `job.json` could say `running` forever, and `publicJob` translated "no worker in this
process" into `paused`. A restart, a crashed worker and a second server on the same directory
were indistinguishable, and the second server could run the same job.

`novel-lease.ts` writes a separate `lease.json` (`ownerId`, `pid`, `startedAt`, `heartbeatAt`)
before the first call, heartbeats every 30s, and releases it when the worker settles. Because the
lease is its own file, a heartbeat can never clobber a concurrent checkpoint write. A lease is
"live" only when it belongs to another process, is fresh (10-minute TTL, well above the 240s call
cap) **and** its PID still exists. Every mutation (start, resume, pause, cancel, settings/direction
edit, artifact reset) refuses a live foreign lease with 409 `novel_busy`.

`reconcileNovelJobs()` runs at startup, persists `interrupted` plus `interruptedAt` for any
`running` job whose owner is gone, clears the dead lease, and appends an `interrupted` event. A
live foreign owner is left alone. Reconcile never auto-starts a job: recovering an interrupted job
still spends money and stays an explicit user action. `interrupted` is a first-class status, so
the UI reports what happened instead of guessing.

**5. Context compaction and automatic memory compression.** `novel_context_budget` used to be a
hard stop. `novel-context.ts` now assembles each request against a budget, in this order:
recoverable-evidence removal (`compactNovelEvidence`), **model summarisation of the rolling
memory** (cached by source text and target, so a resume reuses it), deterministic truncation of
low-value context (`previousOutput`, `history`, `precedingProse`, `priorContinuity`, `memory`) and
whole-field drops (`history`, `observations`, `reportRepair`, `suggestions`, `repairFeedback`).
The audit request's `manuscriptParagraphs` keeps its paragraph numbers but drops the duplicated
text, since code resolves quotes from the manuscript. Source rows, the manuscript, canon evidence
and the scene are never dropped; if the protected evidence alone exceeds 28,000 tokens the call is
refused with a specific detail and no ASR is lost. Compaction is accounted in
`job.compactedCalls`/`compactedTokens`/`compactedReused` and emits a `context_compacted` event.

**6. The loop is explicit.** `novel-loop.ts` is the single bounded act→observe→reflect loop:
a hard turn cap, code-executed actions whose results are observations (never instructions),
repeated-read detection, a bounded observation window, and termination only by a code-validated
change, an explicit conflict, or the budget. The editor agent now describes only its tool surface
and delegates the mechanics to it; the repair loop's history, `revisionPolicy()` invalidation and
the whole-book length pass are unchanged. The step loop in `novel.ts` remains the durable
attempt/repair engine and now feeds the concrete validation detail back on every retry.

Validation: `trpg-novel`, `trpg-novel-lease`, `trpg-novel-context`, `trpg-novel-loop`,
`trpg-novel-material`, `trpg-novel-editor-agent`, `trpg-novel-consistency`, `trpg-novel-revision`,
plus `harness:check`, server `tsc` and client `vue-tsc`. Real six-hour annotated-campaign
evaluation of the reviewer remains pending; these changes address the harness's own failure
classes, not the semantic ceiling of an LLM judge.






