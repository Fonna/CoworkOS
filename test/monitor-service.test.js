import assert from "node:assert/strict";
import { test } from "node:test";
import { serviceDefinition } from "../scripts/monitor-service.mjs";

test("the persistent service is scoped to a workspace and carries config paths rather than credentials", () => {
  const options = {
    workspace: "/tmp/CoworkOS & workspace",
    config: "/tmp/private config.json",
    home: "/tmp/home",
    root: "/tmp/harness",
    node: "/opt/homebrew/bin/node"
  };
  const first = serviceDefinition(options);
  assert.equal(first.label, serviceDefinition({ ...options, port: 3999 }).label);
  assert.notEqual(first.label, serviceDefinition({ ...options, workspace: "/tmp/another" }).label);
  assert.match(first.plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(first.plist, /CoworkOS &amp; workspace/);
  assert.match(first.plist, /private config.json/);
  assert.doesNotMatch(first.plist, /COWORK_API_KEY|COWORK_API_BASE|0\.0\.0\.0/);
  assert.throws(() => serviceDefinition({ ...options, port: -1 }), /有效/);
});
