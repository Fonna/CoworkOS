const { randomUUID } = require("node:crypto");
/** Ask the trusted renderer to finish document transactions before stopping its server. */
function createRendererFlush(getWindow, timeoutMs = 10_000) {
  const pending = new Map();
  return {
    request() {
      const window = getWindow();
      if (!window || window.webContents.isDestroyed() || window.webContents.getURL() === "about:blank")
        return Promise.resolve(true);
      const requestId = randomUUID();
      return new Promise((resolve) => {
        const finish = (saved) => {
          clearTimeout(timer);
          pending.delete(requestId);
          resolve(saved === true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        pending.set(requestId, finish);
        window.webContents.send("bookman:prepare-close", requestId);
      });
    },
    // The main process verifies sender identity before passing a response here.
    acknowledge(requestId, saved) {
      pending.get(requestId)?.(saved);
    }
  };
}
module.exports = { createRendererFlush };
