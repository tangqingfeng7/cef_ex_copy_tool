# Upstream AI source attribution

`deepseek_ai_script.js` was copied and adapted from:

- Project: SJYssr/CxExam_automatic_answering
- URL: https://github.com/SJYssr/CxExam_automatic_answering
- Commit: `3b534edae5208f1b3bdb256142491a6cd28de4a0`
- Original file: `src/scripts/deepseek_ai_script.js`
- License: GPL-3.0 (the root LICENSE is retained in source and release packages).

Retained workflow: exam-page detection, page-load collection, Ctrl+C/copy-to-AI,
click-to-fill, middle-click batch fill, question types and DOM selectors.

Local adaptations: persistent DLL-adjacent config and Ctrl+G popup/opacity, bounded
multimodal vision requests using deepseek-flash, images from question/option DOM,
strict request-delay-fill-next sequential answering, pause/resume controls,
backup-clear-write-verify rich-editor replacement, contextual chat with clipboard-image
paste, safe text insertion, stale-result checks, removal of destructive answer cleanup
and private console logging. Missing/ambiguous multi-blank mapping is left for
manual review instead of copying one answer to every blank. The existing legacy
worker yields to this AI flow on supported exam pages to avoid duplicate requests.
