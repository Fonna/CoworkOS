const { isDashboardUrl } = require("./trusted-content.cjs");

/** Native editing stays in the trusted main frame and uses Chromium's input events. */
function installEditContextMenu(window, { Menu, clipboard, getDashboardUrl }) {
  const contents = window.webContents;
  let menu;
  const trusted = (frame) =>
    !window.isDestroyed() &&
    !contents.isDestroyed() &&
    frame === contents.mainFrame &&
    isDashboardUrl(frame?.url, getDashboardUrl());
  contents.on("context-menu", (_event, params) => {
    if (!params.isEditable || !trusted(params.frame)) return;
    const item = (label, command, enabled) => ({
      label,
      enabled: Boolean(enabled),
      click: () => {
        if (!trusted(params.frame)) return;
        contents.focus();
        contents[command]();
      }
    });
    const flags = params.editFlags;
    menu = Menu.buildFromTemplate([
      item("撤销", "undo", flags.canUndo),
      item("重做", "redo", flags.canRedo),
      { type: "separator" },
      item("剪切", "cut", flags.canCut && params.selectionText.length > 0),
      item("复制", "copy", flags.canCopy && params.selectionText.length > 0),
      item("粘贴", "paste", flags.canPaste),
      item("粘贴为纯文本", "pasteAndMatchStyle", flags.canPaste && clipboard.readText().length > 0),
      { type: "separator" },
      item("全选", "selectAll", flags.canSelectAll)
    ]);
    menu.popup({ window, x: params.x, y: params.y });
  });
  contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) menu?.closePopup(window);
  });
}

module.exports = { installEditContextMenu };
