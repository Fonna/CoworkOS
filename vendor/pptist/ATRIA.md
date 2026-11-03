# PPTist embedded in CoworkOS

Upstream: https://github.com/pipipi-pikachu/PPTist

Pinned commit: `1d5dc853f77e99c0d3d9485ea9e52774f870ee78` (2.0.0).
Copyright © 2020–present pipipi-pikachu and contributors.
This directory, including CoworkOS's modifications, is distributed under the
GNU Affero General Public License v3.0 in LICENSE.

CoworkOS modifications: local initialization and document/selection/save bridge,
embedded header and responsive layout, system font fallback, and removal of
hosted AI/image-search entry points; import validation and HTML sanitization;
portable media embedding; immediate ProseMirror document synchronization;
read-only load transactions; per-editor audience-window channels; PPTX chart
category-cache compatibility; reliable local print-frame loading; and cancellation
of pending fullscreen entry when a presentation exits; passive table viewing
without persisted geometry changes; isolated PPTX file conversion for the host
file-import contract and preference for embedded SVG over raster fallbacks;
chart text colors (including theme colors), legend/value-label visibility and
presentation slide order on PPTX import; matching chart export options and
fractional font-size preservation on export and table import; scaled text insets
on import and read-only inset loading without extra undo entries; product-facing
presentation labels, generic source-file import/export wording, and CoworkOS export
author metadata. Upstream identifiers, native formats, copyright and license
notices remain intact. No credentials are sent to PPTist services.
Table-cell rich text now uses the same allowed-tag sanitization as slide text
and notes at import, display and editing boundaries. Table whitespace formatting
preserves allowed HTML attributes and inline styles.
Both PPTX export paths decode sanitized cell text into editable rich-text runs,
retaining emphasis, inline colors/fonts and literal comparison symbols.
Cell input updates the document immediately, so saving or closing captures the
latest text while undo-history snapshots remain coalesced.
PPTX imports repair the known double-quoted font-attribute form from older
exports in memory, preserving complete tables. Browser exports convert CSS font
families to a single XML-safe Office font name to prevent the same corruption.
The embedded header delegates opening PPTX/JSON files to the host's native file
picker and independent document lifecycle. Inserting slides remains an explicit
separate menu action, preserving the current presentation's save destination.
Save acknowledgements synchronize normalized content while retaining editor
selection and undo/redo snapshots; authoritative document replacements reset
that history. Recovery-draft persistence is separate from explicit original-file saves.
Production dependencies are locked to patched compatible releases; image-size is
overridden to 2.0.4 (PptxGenJS does not use its API in the bundled exporters).
The source archive available from the editor includes these modifications.
The embedded chrome follows CoworkOS's local interface font and neutral light/dark
surfaces. Appearance messages use the same origin/channel validation as document
messages and never alter slide styling. A single host export action, a compact
screening menu, keyboard-focusable undo/redo, and collapsible slide/property
panels keep the canvas available at narrow widths. A single command bar groups
insertion tools in a popover and delegates document actions (including save,
rename, revision review and save-copy) to the host. Capability negotiation keeps
the host fallback controls available for older or unavailable editor builds.
Document state uses the same origin/source/channel validation; slide artwork is
unaffected. Standalone import and export remain available.

Build independently: `npm ci --ignore-scripts && npm run build-only`.
The parent harness builds this directory with `node scripts/build-pptist.mjs`.
`src/atria/bridge.ts` documents the versioned parent-window protocol. The parent
initializes the document with a `load` message; the editor intentionally does not
open example slides or store user documents on an upstream server.

Bundled upstream font binaries are omitted. Installed system fonts are used;
font substitution may affect layout on another computer.
