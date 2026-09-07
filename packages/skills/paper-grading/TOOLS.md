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
| grading_view_image | scanId | the scan image as an image block, for visual reading |
| grading_add_annotation | scanId; annotationId/remove/kind/bbox/content/color/width/points | add, update, or remove one annotation |

Coordinate values refer to original image pixels. OCR words are text lines; diff ranges refer to absolute line indices, not characters. Never construct coordinates or overwrite OCR text to improve a score. Camera/export requests time out if the workspace is unavailable or the teacher does not respond.
