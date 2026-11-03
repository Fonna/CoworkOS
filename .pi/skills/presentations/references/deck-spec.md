# Editable components

Run `node <skill-directory>/scripts/build_deck.mjs deck.json deck.pptx`. Components are optional building blocks; use custom PptxGenJS when the planned composition or explanation needs it. Keep the JSON and generated `.layout.json` for editable content, element IDs and repairs.

Top-level fields: `title`, `language` (default zh-CN), `theme`, `slides`. Theme may be `teal`, `navy`, `terracotta`, `arena`, `court`, or an override object `{preset,font,ink,accent,pale,paper,muted}`. Colors are six hex digits without `#`. Presets are starting palettes, not required subject templates. Select fonts installed on the rendering and delivery systems; use `fc-match`/`fc-list` when fontconfig is available. Do not assume a font from another operating system is installed. Choose and validate a suitable CJK fallback when required.

Every slide has `type`, `title`; optional `subtitle`, `notes`, `source`, `surface: "dark" | "light"`. Hero pages are dark, with a dedicated text panel. Other pages support both surfaces. Charts require a traceable source and units; illustrative values must be labeled on the page. Shorten content or choose a larger/custom composition when fit validation fails; do not shrink type to bypass it.

| Type            | Fields                                                                             | Notes                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| hero            | image, optional kicker/subtitle/takeaway                                           | Large cropped photo on right, opaque text panel on left; inspect the crop. A cover/closing with image also uses this treatment |
| image           | image, items:[text], optional imageSide:"left" or "right", fit:"contain" or "crop" | Large image and supporting editable text; contain by default, preserving the full image                                        |
| annotated-image | image, annotations:[{x,y,title,body}]                                              | Full contained image and 1–4 numbered pins with a right-hand legend; x/y are normalized **image** coordinates 0–1              |
| gallery         | images:[{image,title,caption?,fit?}]                                               | 2–4 large images with editable labels; cropped by default, use contain to preserve complete diagrams                           |
| diagram         | nodes, edges, optional takeaway                                                    | Editable labeled nodes and directional connectors; schema below                                                                |
| cover / closing | title, optional kicker/subtitle/takeaway                                           | Typography-led opening/closing; image is optional                                                                              |
| comparison      | columns:[{title,items:[text]}]                                                     | Exactly 2 columns, 1–5 short items each                                                                                        |
| flow            | steps:[{title,body}]                                                               | 3–5 textual steps; use diagram for actual mechanisms and spatial/temporal structure                                            |
| timeline        | events:[{label,title,body}]                                                        | 3–4 dated events                                                                                                               |
| chart           | chart:{type,unit,labels,series:[{name,values}]}, takeaway, source                  | Native editable bar/line; 2–8 labels, 1–3 series                                                                               |
| statement       | statement, optional items:[text]                                                   | One prominent conclusion                                                                                                       |

Image paths are relative to deck.json. Image text is not automatically transcribed; add meaningful labels as native text. Crops retain aspect ratio but may cut off a subject, so inspect them after rendering. Sources for images and factual claims can be recorded in `source` and speaker `notes`.

For custom PptxGenJS pages, import `containRect` or `coverRect` from `scripts/pptx_helpers.mjs`, read the actual source width/height (for example with Pillow `Image.open(path).size`), then call `slide.addImage({path,...coverRect(sourceWidth,sourceHeight,x,y,w,h)})`. Do not use the target box dimensions as the source image ratio. The helpers calculate geometry from the source aspect ratio; verify the resulting crop or containment after rendering.

## Native diagram schema

Each node is `{id,label,x,y,w,h,kind?,tone?}`. Coordinates and dimensions are fractions of the content region (not inches), must stay within 0–1, and must leave sufficient space for readable 22 pt labels. `kind` is `box` (default) or `ellipse`; `tone:"accent"` highlights a node. Use distinct node IDs.

Each edge is `{from,to,label?,fromPort?,toPort?}`. Edges are drawn behind nodes with arrowheads; the default connects their boundaries in the direction of the other node. Ports may be `left`, `right`, `top`, `bottom`. Labels are short annotations near the edge midpoint. Arrange nodes to avoid crossing other nodes, overlapping labels or ambiguous direction. For recurrent structures, unroll time into separate nodes or use custom PptxGenJS for a routed loop; self-edges are rejected.

```json
{
  "title": "从输入到预测",
  "theme": { "preset": "teal", "font": "Droid Sans Fallback" },
  "slides": [
    {
      "type": "diagram",
      "title": "模型把输入变为可比较的预测",
      "nodes": [
        { "id": "x", "label": "输入 x", "x": 0, "y": 0.25, "w": 0.22, "h": 0.4 },
        { "id": "f", "label": "模型 f", "x": 0.39, "y": 0.25, "w": 0.22, "h": 0.4, "tone": "accent" },
        { "id": "y", "label": "预测 y", "x": 0.78, "y": 0.25, "w": 0.22, "h": 0.4 }
      ],
      "edges": [
        { "from": "x", "to": "f" },
        { "from": "f", "to": "y" }
      ],
      "takeaway": "箭头表示数据流；训练还需要目标与损失。"
    }
  ]
}
```

Run `validate_slides.mjs`, render with `render_slides.mjs`, then review the actual PNGs. The fit guard and layout manifest cannot establish image quality, arrow semantics or visual appeal.
