# Web production reference

English | [中文](../creative-workflows.md)

## Existing projects

Use the project directory as the working directory. Name the page, main interaction and design to preserve. CoworkOS uses the project's framework, dependencies and run commands. For example:

```text
Read the current project and add a date filter to the event list. Reuse existing components and colors. Update the list and count together, and preserve the other filters. Run the project's existing checks and explain how to preview locally.
```

## Standalone pages

Provide the content, data and assets, and name the entry file and output directory. For offline use, request all scripts, fonts, images and their licenses without external CDN dependencies.

Preview standalone pages through local HTTP. If Python 3 is installed, run this from the project directory:

```sh
python3 -m http.server 8000 --bind 127.0.0.1 --directory event-site
```

Open `http://127.0.0.1:8000/` in your browser. Press Ctrl+C in the terminal to stop the preview. Replace `event-site` with the actual directory.

## Interactions and animation

For a prototype, describe the main flow, sample data or real API, and whether input should survive a refresh. Request working feedback from filters, forms and buttons, and check keyboard use and narrow layouts.

For browser animation, specify the duration, frame size and main actions. MP4 and other video deliverables need actual capture, encoding and playback checks. Before encoding, the output remains a browser animation.

For online publication, name an already configured platform and explicitly request deployment. A local preview URL is available only on the current machine.
