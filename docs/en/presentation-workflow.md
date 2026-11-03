# Presentation editing reference

English | [中文](../presentation-workflow.md)

## Create and edit

To generate a standalone PPTX, provide the source files, audience, duration and output path. See [application features](applications.md) for the PPT editor's import, editing and export capabilities.

To revise an existing deck, open it in Applications → PPT, return to the conversation and name the slides and content to preserve. For example:

```text
Split slide 3 into two slides: keep the method and original image on the first, and put the experimental results on the second. Preserve the theme, captions and data. Leave the other slides unchanged.
```

Finish active text input before asking CoworkOS to make changes. Review and adjust the result in the editor.

## Save and export

Manual edits are retained as a recovery draft. For a linked local file, click Save or press ⌘/Ctrl+S to write back to the original. Switching, exporting and closing a deck only preserve the draft.

Choose PPTX in the export panel. Keep a JSON/PPTIST source file for later editing; PPTX conversion can change complex layouts, animations or fonts.

Before delivery, check numbers, sources, overlapping text, chart labels and image crops on every slide. See the [presentation tools reference](presentation-reference.md) for standalone generation commands, rendering dependencies and check parameters.

## Vision connection

Automated image review needs a model that supports image input. If your chat model accepts only text, save a separate vision profile in Model connections and select “用此连接分析图片，供纯文本模型使用” (Use this connection to analyze images for text-only models). See [model settings](configuration.md).
