import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WatchProgramStore } from "../dist/src/runtime/watch-program-store.js";
import { startDashboard } from "./dashboard-fixture.mjs";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

for (const api of ["openai-completions", "openai-responses"])
  test(`${api}: Dashboard monitoring inherits the configured provider and Main budget`, async (t) => {
    const provider = await modelProtocolFixture(api, () => ({
      text: "classification: no_change\nThe captured event needs no user notification."
    }));
    let dashboard;
    t.after(async () => {
      await dashboard?.stop();
      await provider.close();
    });
    dashboard = await startDashboard({
      modelEndpoint: provider.baseUrl,
      model: "protocol-fixture",
      monitoring: true,
      config: {
        api,
        thinkingFormat: "openai",
        supportsPromptCacheKey: true,
        contextWindow: 131072,
        mainMaxTurns: 3,
        mainMaxTokens: 2048,
        mainTimeoutMs: 20000,
        subagentMaxTokens: 128
      }
    });
    const source = join(dashboard.root, "metric.json");
    const metric = (value) =>
      writeFile(
        source,
        JSON.stringify({ metric: "loss", unit: "ratio", value, observedAt: new Date().toISOString() })
      );
    await metric(0);
    const response = await fetch(`${dashboard.base}/api/monitors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "Classify a captured metric without reporting routine changes.",
        template: "metric-threshold",
        source,
        scope: "background",
        eventMode: "analyze",
        cadenceSeconds: 60,
        config: { metric: "loss", unit: "ratio", threshold: 2, consecutiveSamples: 1 }
      })
    });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));
    const programs = new WatchProgramStore(dashboard.workspaceRoot);
    await metric(3);
    await programs.updateVirtualAgentState(created.taskId, created.programId, created.monitorId, {
      lastCheckedAt: "1970-01-01T00:00:00Z"
    });
    let state;
    for (let attempt = 0; attempt < 600; attempt++) {
      state = await programs.readVirtualAgentState(created.taskId, created.programId, created.monitorId);
      if (state.lastClassification === "no_change") break;
      await delay(50);
    }
    assert.equal(state.lastClassification, "no_change", JSON.stringify(state));
    assert.equal(provider.requests.length, 1, "a quiet analysis does not launch another Main request");
    const request = provider.requests[0];
    assert.equal(request.path, api === "openai-responses" ? "/v1/responses" : "/v1/chat/completions");
    assert.equal(
      request.body.max_output_tokens ?? request.body.max_completion_tokens ?? request.body.max_tokens,
      2048
    );
    assert.equal(request.body.model, "protocol-fixture");
    assert.equal(typeof request.body.prompt_cache_key, "string");
    assert.ok(request.body.prompt_cache_key.length > 0);
    assert.equal(state.modelRunCount, 1);
  });
