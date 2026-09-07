# Native MCP tools

The tools are served by the existing `hermes-studio-mcp api` transport. Each accepts an optional `profile`.

Scans are stored as files in the Hermes profile workspace under `grading/` (an image plus a matching `.json` metadata file). There is currently no class/exam SQL model.

| Tool | Required inputs | Result |
| --- | --- | --- |
| grading_capture_scan | optional examId, pageNumber | scanId, width, height after teacher capture |
| grading_ocr | scanId | cached OCR words and coordinates |
| grading_detect_questions | scanId, rubric | question blocks; OCR line ranges use exclusive end |
| grading_grade | scanId, rubric; optional subject | scores, confidence, feedback and diffOps |
| grading_apply_edits | scanId | deterministic annotations |
| grading_render | scanId; optional style rough/printed | client download confirmation |
| grading_summary | scanIds | totals, question statistics, wrongRank |
| grading_list | none | scanned papers in the profile grading folder |
| grading_get | scanId | full metadata: OCR words, detected questions, results, annotations (no image bytes) |
| grading_lines | scanId | OCR words grouped into rows, each with a merged pixel bbox and its word list |
| grading_view_image | scanId | the raw scan image as an image block, for reading the layout |
| grading_preview | scanId; optional style rough/printed | the scan composited with its CURRENT annotations, as an image block for verifying positions/overlaps |
| grading_add_annotation | scanId; annotationId/remove/kind/bbox/content/color/width/points | add, update, or remove one annotation |

Coordinate values refer to original image pixels (top-left origin, same coordinate space as `grading_lines` bbox and the scan image). **Read first, then mark**: `grading_view_image` (look at the handwriting) + `grading_get`/`grading_lines` (read the OCR text) **before** any mark. **Anchor every mark to a `grading_lines` bbox** — pick the row whose `text` matches the content you are marking, then use that row's `bbox` (or a tight sub-box of it) as the annotation `bbox`. Do not estimate a bbox from `grading_view_image`; OCR rows already give exact pixel boxes.

**Content must be real, not a label**: only add marks for actual grading (correct/wrong, a score, a comment quoting the real text). **Do not translate the note or label every line** with a gloss (e.g. an English "Film Lobster Cockpit video" per line) — that is noise, not grading. If a row's text is unreadable, flag it and ask the teacher instead of inventing content. Prefer one small mark per line (a `circle`/`underline` on the answer, a `badge` for the score, a short `comment`), not large region boxes. diff ranges refer to absolute line indices, not characters. Camera/export requests time out if the workspace is unavailable or the teacher does not respond.
