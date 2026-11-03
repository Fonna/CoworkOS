const path = require("node:path");
const { atriaHome } = require("../scripts/data-home.cjs");

/** Resolve identity before Chromium's profile and the single-instance lock are initialized. */
function desktopProfile({ isPackaged, appRoot, appData, env = process.env }) {
  const development = !isPackaged || env.COWORK_DESKTOP_DEV === "1";
  const name = development ? "CoworkOS Dev" : "CoworkOS";
  return {
    development,
    name,
    encryptionName: "Atria",
    canMigrateLegacy: !env.ATRIA_HOME && !env.COWORK_DESKTOP_DATA,
    appRoot:
      development && env.COWORK_DESKTOP_SOURCE_ROOT ? path.resolve(env.COWORK_DESKTOP_SOURCE_ROOT) : appRoot,
    userData: path.resolve(env.COWORK_DESKTOP_DATA || atriaHome(env)),
    legacyUserData: path.join(appData, development ? "Atria Dev" : "Atria")
  };
}

module.exports = { desktopProfile };
