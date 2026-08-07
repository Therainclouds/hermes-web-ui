---
date: 2026-07-17
pr: pending
feature: Generated file and workspace diff previews
impact: Session, Profile-generated, and group-chat workspace artifacts plus run diffs open inside the existing resizable workspace panels with bounded authenticated reads and a close-the-panel interaction.
---

The session workspace API now exposes authenticated, size-limited text and
binary preview reads while retaining the existing UTF-8 editor contract. Reads
accept files inside either the session workspace or the session Profile's
Hermes-generated workspace. Group-chat previews use the room workspace or the
workspaces of the room's Agent Profiles and require room-management access.
Session/room access, lexical containment, and real-path containment checks are
applied to every response.

Opening a workspace file preview or a run diff temporarily replaces the
Workspace and Terminal tabs inside the existing resizable chat tool panel. The
preview provides its own close action, which closes the complete tool panel
without introducing another nested drawer. Text preview detection covers common
source languages, scripts, templates, configuration formats, and build files.

Generated HTML opens in an isolated sandbox with a highlighted source mode and
hidden scrollbars. PDF, DOCX, PPTX, XLSX, and CSV use lazy, local-only renderers;
PPTX additionally applies bounded ZIP parsing, slide navigation, zoom, and
active-content cleanup. Inline chat images keep their dedicated full-screen
image overlay instead of opening the generic file preview panel.
