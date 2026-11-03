const { existsSync } = require("node:fs");
const { join } = require("node:path");

/** Only exported app icons are suitable for the Dock; never substitute raw brand artwork. */
function selectApplicationIcon(appRoot) {
  return [join(appRoot, "dist/src/desktop/atria-icon.png"), join(appRoot, "build/atria-icon.png")].find(
    (candidate) => existsSync(candidate)
  );
}

function refreshDockIcon(appRoot, dock) {
  const icon = selectApplicationIcon(appRoot);
  // No override leaves Electron/macOS using the bundle's normal app icon.
  if (icon) dock?.setIcon(icon);
}

module.exports = { selectApplicationIcon, refreshDockIcon };
