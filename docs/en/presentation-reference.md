# Presentation tools reference

English | [中文](../presentation-reference.md)

Bound PPTist documents continue to use application reads, atomic edits and exports, preserving revisions and manual changes. Standalone PPTX deliverables can use the `presentations` component builder. Both routes share package validation, actual rendering and per-page review. Generated files never replace the versioned edit protocol of a bound document.

Plan the audience, evidence, takeaway and primary visual of each page before drawing. Keep fonts, palette and margins consistent. Quantitative charts need sources and units; illustrative values must be labelled. Shorten or split dense content instead of shrinking fonts. Keep the native PPTist source alongside compatibility exports, or retain the standalone JSON/PptxGenJS source and generated `.layout.json` element index.

Source-checkout commands:

```sh
npm run slides:build -- deck.json deck.pptx
npm run slides:validate -- deck.pptx
npm run slides:render -- deck.pptx --output-dir preview
```

Product agents resolve actual bundled paths with `load_skill({name:"presentations"})` and publish accepted files with `publish_artifact`.

The optional component builder supports image-led covers, galleries, annotated images and native node/connector diagrams alongside the existing covers, comparisons, flows, timelines, charts, images and statements. It supports light/dark surfaces, image positioning and aspect-preserving containment/cropping; use custom PptxGenJS when the composition needs it. Run `check_backend.mjs` from the project directory to discover likely local assets with paths, formats, sizes and available pixel dimensions. An inventory helps select assets but is not visual inspection: inspect the selected images whose subject, crop or embedded labels affect the design.

For a multi-page deck involving external sources, one focused async helper can verify claims and captions while Main plans and authors. Skip delegation for simple or already-verified material. Keep one source author and incorporate factual evidence before finalizing the deck.

Validation uses Python 3's standard library for XML, package relationships, page order and bounds; overlap, text fit and font availability are advisory. Optional fontconfig checks installed fonts; `--strict-fonts` fails when fonts cannot be verified. Groups, rotations, inherited fonts and differences between machines require rendered review.

PPTX rendering needs LibreOffice, Poppler's `pdftoppm` and Python 3. The contact sheet uses standard-library Python and Poppler PPM thumbnails, without ImageMagick or Pillow. Existing PDF inputs only need Poppler and Python. `check_backend.mjs` reports creation, validation, PPTX rendering and PDF rendering separately. It never installs dependencies. Existing executables may be selected with `COWORK_SOFFICE_PATH`, `COWORK_PDFTOPPM_PATH` and `COWORK_PYTHON_PATH`.

Outputs include PDF, page PNGs, a contact sheet and `render-manifest.json` with source/image SHA-256 hashes. Failure or a source change during rendering leaves no valid success manifest. This establishes artifact correspondence, not visual quality.

When an image-analysis connection is configured, `review_slides` accepts every final PNG in page order and the contact sheet as `overview` in one batch. The queue defaults to two workers, accepts 1 to 4 when provider capacity is known and starts the next image as a worker finishes.

Follow the active tool schema: Main defaults to `scope:"project"`, runtime agents to `scope:"work"`; choose `scope:"task"` for shared Task previews. Slide and overview paths resolve against that selected input root and can be relative or absolute within it.

`reportPath` resolves independently inside the Agent's own report directory: Task `agents/main/work/` for Main, or the runtime agent's own working directory. Ledger paths can be relative to that report directory or absolute inside it; returned `reportScope:"work"` identifies this base.

Shared Task image scope does not grant shared writes. Traversal and symlink escapes are rejected.

```json
{
  "slides": [
    {
      "path": "preview/slide-01.png",
      "goal": "Explain the input-to-prediction relationship; check arrows, labels and legibility"
    }
  ],
  "overview": { "path": "preview/contact-sheet.png" },
  "reportPath": "preview/review.json",
  "concurrency": 2
}
```

List all final pages in actual calls; the example only illustrates one page. The tool saves hashes, model, issues, status and attempt history. After repairs, submit every final PNG with the same report path and stable per-page goals so unchanged checks can be reused, including across restarts. `everySubmittedPagePassed` covers submitted pages only; Main must establish complete deck coverage. Preserve the actual ledger and record repair decisions separately; never fabricate passing checks.

Use `read_image` for contact sheets and individual pages when no vision connection is configured or the batch tool is unavailable. A contact sheet checks consistency and rhythm, not individual-page legibility. Main defaults to project-relative paths (`scope:"project"`); runtime agents default to their private work directory (`scope:"work"`). Shared Task reads use `scope:"task"`. `read_image` prefers relative paths and also accepts absolute paths inside the selected root. Real-path checks reject traversal and symlinks outside allowed roots.

Native image models receive pixels and Main records its review. Text-only models receive evidence from the selected image-analysis connection. Structured reviews contain `pass`, `needs_revision` or `unreviewed`, a summary and at most six issues with locations and fixes. Batch review always uses that vision connection. Separate source/factual verification and diagram meaning from visible clipping, overlap and contrast issues; a vision report cannot authenticate external facts.

Read the complete batch before editing, then make one consolidated repair and regenerate/render together. Reserve a second repair round for remaining major defects. Retry a failed check at most once and report unchecked pages, failures and remaining defects. Keep stable goals instead of changing wording to bypass retry limits.

`read_image` caches successful image/goal/connection evidence per tool session. Concurrent calls share requests within the same cancellation scope. Two identical failures stop retries; cancellation propagates to the provider and does not use that image-reader failure budget. Cancelled or absent responses never count as passes. Neither the session cache nor the batch ledger is a provider-wide billing quota.

In model settings, save an image-capable profile and select “用此连接分析图片，供纯文本模型使用”. Saving this role preserves the active chat connection. Selected images are sent to that service. Desktop secrets remain encrypted by safeStorage; Web/CLI use existing private configuration. Both Chat Completions and Responses reuse the existing connection protocols. See [configuration](configuration.md).

Tests: [file generation and rendering](../../test/presentation-files.test.js), [protocol/path/cancellation](../../test/vision-model.test.js), [batch queue, persistence and evidence reuse](../../test/slide-review.test.js), and [real Pi integration](../../test/vision-pi.test.js). Local fake providers and isolated workspaces verify integration, not real-model visual quality. Native desktop, actual models and final packages need separate acceptance.

## Image comparison

Single-image `path` remains supported. Prefer `paths` for one image or an ordered comparison of 1 to 4 PNG/JPEG/GIF/WebP images, omitting the unused `path` alias. Matching `path` and `paths:[path]` read the image once; empty placeholder aliases are ignored. Conflicting selections are rejected. The default per-image limit and comparison total are 20 MiB. Results include each path and image hash, and changing order, pixels or goal invalidates the comparison cache. Native image models receive every image; text-only agents obtain one comparison from their selected vision connection.

```json
{
  "paths": ["preview/before.png", "preview/after.png"],
  "scope": "task",
  "goal": "Compare heading overlap and mobile layout"
}
```

Comparison assesses changes; `review:true` still requires one page at a time. Every image passes the same real-path, format and byte checks before a request. Cancellation propagates through file reads and model requests.
