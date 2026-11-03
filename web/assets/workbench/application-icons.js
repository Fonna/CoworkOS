import { icon } from "../ui/icons.js";

const APP_ICONS = {
  "text-editor": "i-text",
  pptist: "i-slides",
  cad: "i-cad",
  blender: "i-blender",
  "blender-harness": "i-blender",
  "freecad-harness": "i-cad",
  "cad-harness": "i-cad",
  "office-harness": "i-slides"
};

/** One monochrome glyph follows an application across launchers, files and tabs. */
export function applicationIconName(appType, fallback = "i-file") {
  return APP_ICONS[appType] || fallback || "i-file";
}

export function applicationIcon(appType, fallback) {
  return icon(applicationIconName(appType, fallback).replace(/^i-/, ""), "application-icon");
}
