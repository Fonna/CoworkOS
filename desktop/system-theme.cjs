// Appearance owns Electron's selected theme; keep the window's first paint in sync.
function windowBackground(nativeTheme) {
  return nativeTheme.shouldUseDarkColors ? "#0d0d0d" : "#f7f7f8";
}
function followNativeTheme(window, nativeTheme) {
  const update = () => {
    if (!window.isDestroyed()) window.setBackgroundColor(windowBackground(nativeTheme));
  };
  nativeTheme.on("updated", update);
  window.once("closed", () => nativeTheme.removeListener("updated", update));
  update();
}
module.exports = { windowBackground, followNativeTheme };
