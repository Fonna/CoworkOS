"use strict";

/**
 * Preload for the CAD step-selector WebContentsView (the 装配体/零件/版本 dropdown
 * strip under the viewer). Exposes a minimal, trusted bridge so the self-contained
 * selector widget can report a user's selection back to the main process, which
 * then navigates the viewer.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cadSelector", {
  select: (id) => ipcRenderer.send("bookman:cad-viewer:select-step", { id: String(id) })
});
