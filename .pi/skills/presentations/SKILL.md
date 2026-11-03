---
name: presentations
description: Create, revise, inspect, render, and validate PowerPoint presentations (.pptx). Use when slides, pitch decks, briefings, visual storytelling, or presentation templates are a primary input or output.
---

# Presentations

Plan presentations as visual stories, then render and inspect them before delivery. For a bound PPTist resource, load `pptist` and edit through its application tools so manual changes and revisions survive. For a standalone PPTX deliverable, use the existing `pptxgenjs` dependency and component builder. LibreOffice is the rendering/conversion backend.

## Workflow

1. Load this skill with `load_skill` and run `node <absolute-script-path>` using its returned `scripts["check_backend.mjs"]`. When loaded by `read`, resolve `scripts/check_backend.mjs` against the actual parent directory of the SKILL.md. Run from the project working directory to discover likely input images with paths and pixel dimensions; inspect supplied locations separately when files live elsewhere. If a requested backend is missing, report that specific limitation; do not silently fake an Office file or install dependencies.
2. Inspect the request, source material, images, brand assets, existing decks and intended audience. Preserve a supplied template. For a short request, infer a sensible audience and proceed; do not require a design brief. Default new decks to 16:9.
3. For a multi-page deck with external sources, consider one focused `call_subagent` in async mode to verify facts and source captions while Main inventories imagery and plans the deck. Give explicit source paths and ask for supported claims and risky wording, not another PPT. Skip delegation when the material is already verified or the deck is trivial. Keep one author for the source; cap preparation helpers at two and incorporate their evidence before finalizing facts.
4. Read [design-and-content.md](references/design-and-content.md) for a new deck. Choose typography, palette, imagery and composition from the subject. Inspect selected assets whose crop, subject or embedded labels affect the design with `read_image`; do not analyze the entire unused inventory. Reuse source inspection evidence and inspect final placement during deck review. An asset list alone is not visual inspection.
5. Draft a concise page plan: takeaway, supporting evidence/source, primary visual and composition. Use images to establish identity, diagrams to explain mechanisms and charts only for sourced quantities. Record audience and density, and lock fonts, palette and margins across the deck.
6. For bound documents, follow `pptist`: read the current outline and schema, edit atomically, handle layout warnings and export with `export_resource`. Do not replace a bound resource with a generated file or bypass its revision protocol. For standalone decks, use PptxGenJS or the editable components in [deck-spec.md](references/deck-spec.md); the builder is optional and the page plan need not fit its layouts. Preserve JSON or `.mjs` source for reproducible repairs. Keep text, labels, diagrams, charts and tables editable when possible.
7. Run `node <skill-directory>/scripts/validate_slides.mjs <deck.pptx>` for package, relationship, bounds, font and estimated text-fit checks. Inspect warnings; these checks do not establish visual quality.
8. Run `node <skill-directory>/scripts/render_slides.mjs <deck.pptx> --output-dir <preview-dir>` to produce a PDF, per-slide PNGs, contact sheet and render manifest. Already-rendered PDF input works without LibreOffice. Backend detection and the scripts describe cross-platform executable overrides.
9. Follow [visual-review.md](references/visual-review.md). When `review_slides` is available, submit all final PNGs and the contact sheet as `overview` in one batch (default concurrency 2); keep the same report path and page goals after repairs. The ledger stays in the Agent's own report/work directory even when image `scope` is `task`. Otherwise inspect every page with `read_image`, one page per structured review. Collect findings, make one consolidated repair, rebuild/render once and review changed pixels. Reserve a second repair round for remaining major defects. At most one retry per failed check; report remaining defects and unreviewed pages.
10. Deliver the editable PPTX and preserve a bound document's native source. Include the rendered PDF when useful or requested, and report validation/render evidence. Main uses `publish_artifact` for accepted files; Subagents keep candidates under their private `deliverables/`.

## Visual rules

- Prefer a designed composition over a repeated grid of generic cards. Use whitespace, hierarchy and a small number of strong visual anchors.
- Make subject identity visible in imagery and explanation, not only the title. Use suitable supplied assets; restrained technical or mathematical slides need not contain stock imagery.
- Keep titles concise and body copy sparse. Split paragraphs or move detail to notes. Use 18–24 pt for ordinary body copy and smaller type only for citations or compact figure labels; recompose paragraphs that only fit at 12–14 pt.
- Use real charts for quantitative claims and diagrams for relationships. Do not invent data or add decorative numerical charts to fill space.
- Verify diagram labels, connections and spatial orientation against the source. A plausible-looking schematic can still explain the wrong relationship.
- Maintain consistent typography, margins, color and page furniture. Choose fonts installed on the rendering and delivery systems, with appropriate CJK fallbacks.
- Do not stretch images. Contain diagrams/screenshots when the full image is evidence and crop photography intentionally. Keep factual labels as editable text.
- For custom PptxGenJS pages, use `containRect`/`coverRect` from `scripts/pptx_helpers.mjs` with actual source dimensions. Do not substitute target box dimensions for the source aspect ratio.
- Treat structural validation and visual review as separate gates: a valid PPTX can still be unreadable.

## Multimodal review

Use `read_image` for selected reference images, screenshots and comparisons. Native image models receive pixels; text-only models receive textual evidence from the image-analysis connection selected in model settings. Use the active tool schema and paths relative to its declared scope. A timeout, malformed review or missing result is unreviewed, never a pass. A vision report can identify visible defects but does not authenticate source facts.

When image generation is available, use it for appropriate assets and keep the deck functional without generated imagery. The helper scripts accept `--help` and are the source of truth for command options.
