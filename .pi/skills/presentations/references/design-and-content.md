# Design and content decisions

Use this guide for new decks and substantial redesigns. Preserve an existing template for small edits. A short user request is enough to start: choose and record an appropriate visual direction yourself.

## Choose the direction from the content

Select typography, palette, image treatment and compositions as a coherent system. Inspect useful supplied assets before designing around them. Keep a brief asset inventory (path, subject, useful crop, source); reject images that do not support the message. Do not assume that every picture fits a full-bleed crop.

| Subject           | Useful starting direction                                                                        | What the visuals should explain                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Games and esports | Strong character or gameplay imagery, deliberate dark/light contrast, concise oversized headings | Playing field, roles, objectives and a concrete play sequence; use editable annotations rather than paragraphs over screenshots |
| Sports            | Action photography, strong numerical hierarchy, restrained team/event color accents              | Court/field positions, season or tournament structure, sourced comparisons; give statistics a date and a consistent unit        |
| Teaching          | Calm high-contrast canvas, readable math, color used consistently for variables/components       | A worked example, input/output, spatial or temporal structure, and how changing one component changes the result                |
| Research reports  | Precise technical typography, generous figure area, clear separation of claims and evidence      | Method structure, experimental comparison, limitations; use legible paper figures or faithful editable redraws                  |

These are choices to adapt, not four mandatory templates. A typography-led deck can be strong when the content supports it. Different subjects should not default to the same blue-and-white report with substituted titles.

## Plan the page before choosing a layout

Give each page a takeaway and the visual needed to understand it. A compact plan can record `takeaway / evidence / primary visual / composition`. Spatial relationships need a map or schematic; recurring state needs a connected unrolling; a mechanism needs labeled components and arrows. A numbered text list does not explain those relationships by itself.

Choose among image-led, diagram-led, data-led and typography-led pages. Alternate scale and composition where the narrative changes; do not manufacture variety by changing colors alone. Repetition is useful for direct comparisons, but several consecutive generic panels often signal that the explanation was never designed.

Use `build_deck.mjs` when its components fit the plan. Use direct PptxGenJS for layouts it cannot express; the helper's component list is not a limit on the final deck.

## Compose a slide

- Establish a clear reading order: takeaway, dominant evidence or visual, supporting explanation. Keep titles, citations and page furniture consistent.
- Use a consistent grid and safe margins (roughly 0.45–0.65 inches for ordinary content on 16:9). Use scale, weight and position to create hierarchy.
- Give meaningful visuals enough space. A tiny decorative picture next to a wall of text does not make a page visual. Move secondary prose to notes or another page.
- Whitespace should isolate an important element or guide the reading path. If everything clusters at the top and the bottom is empty, reconsider scale or composition before adding more words.
- Keep ordinary body text around 18 pt or larger, depending on viewing distance. Fix content density and box dimensions before shrinking fonts.
- Contain diagrams/screenshots when the full image is evidence; crop photography deliberately. Keep faces, objects and embedded labels intact. Avoid busy images behind body text; use a dedicated text region or opaque panel.

## Evidence and diagrams

Use charts only when the values and their meaning are supported. Record a traceable source, date and units; verify every plotted value against it. Never invent category counts, rankings or trend points to obtain a more impressive slide. When reliable data is absent, use a qualitative relationship diagram or omit the claim.

For technical diagrams, specify nodes, direction, labels and the intended causal/spatial/temporal relationship. Keep labels as native slide text. For a worked example, show actual intermediate values and label illustrative numbers explicitly. Add only details you can explain accurately; decorative arrows can mislead as easily as false numbers.

## Evaluate the rendered result

At contact-sheet scale, inspect topic identity, dominant visual regions and repeated compositions. At page scale, inspect crops, contrast, reading order and whether the visual actually teaches the takeaway. A deck can be legible and still need design revision. Use [visual-review.md](visual-review.md) to record and address specific problems within the normal repair budget.
