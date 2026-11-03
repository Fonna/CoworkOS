import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuredWebTools,
  publicWebSearchStatus,
  saveWebSearchConfig
} from "../dist/src/runtime/web-search-config.js";

test("fresh configuration discovers anonymous Exa and legacy explicit selections survive", () => {
  assert.deepEqual(configuredWebTools({}, {}), { provider: "exa", exaApiKey: undefined });
  assert.equal(configuredWebTools({ serperApiKey: "fixture" }, {}).provider, "serper");
  assert.equal(configuredWebTools({ webTools: false, serperApiKey: "fixture" }, {}), undefined);
  assert.equal(configuredWebTools({}, { COWORK_WEB_TOOLS: "0" }), undefined);
  assert.equal(configuredWebTools({ webSearch: { provider: "off" } }, { COWORK_WEB_TOOLS: "1" }), undefined);
  assert.equal(
    configuredWebTools({ webSearch: { provider: "exa" }, serperApiKey: "old" }, {}).provider,
    "exa"
  );
  assert.equal(
    configuredWebTools({ webSearch: { provider: "serper" } }, { COWORK_EXA_API_KEY: "new" }).provider,
    "serper"
  );
  assert.throws(() => configuredWebTools({ webTools: "false" }, {}), /boolean/);
  assert.throws(() => configuredWebTools({ webSearch: { provider: "invalid" } }, {}), /provider/);
});
test("optional Exa credentials stay private, are retained or explicitly cleared", () => {
  const config = {
    webSearch: { provider: "exa", exaApiKey: "secret", encryptedExaApiKey: "encrypted" },
    serperApiKey: "old"
  };
  assert.equal(publicWebSearchStatus(config, {}).authenticated, true);
  assert.doesNotMatch(JSON.stringify(publicWebSearchStatus(config, {})), /secret|encrypted|old/);
  assert.equal(saveWebSearchConfig(config, { provider: "off" }).webSearch.exaApiKey, "secret");
  assert.equal(
    saveWebSearchConfig(config, { provider: "exa", clearExaApiKey: true }).webSearch.exaApiKey,
    undefined
  );
  assert.equal(
    saveWebSearchConfig(config, { provider: "exa", clearExaApiKey: true }).webSearch.encryptedExaApiKey,
    undefined
  );
  assert.throws(() => saveWebSearchConfig(config, { provider: "exa", exaApiKey: "bad\nkey" }), /单行/);
});
