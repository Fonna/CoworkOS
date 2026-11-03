import { test } from "node:test";
import assert from "node:assert/strict";
import { PiSession } from "../dist/src/runtime/pi-session.js";
import { createCoworkModel } from "../dist/src/runtime/model-profile.js";
import { modelProtocolFixture } from "./model-protocol-fixture.mjs";

for (const changed of ["endpoint", "profile"]) {
  test(`switching ${changed} with the same model name discards foreign encrypted reasoning, retaining visible history`, async (t) => {
    const provider = await modelProtocolFixture("openai-responses", () => ({ text: "continued" }));
    t.after(() => provider.close());
    const originalModel = createCoworkModel({
      baseUrl: changed === "endpoint" ? "https://old.example/v1" : provider.baseUrl,
      api: "openai-responses",
      model: "same-name",
      connectionId: "profile-a",
      supportsReasoningEffort: true
    });
    const initialMessages = [
      { role: "user", content: "remember visible history", timestamp: 1 },
      {
        role: "assistant",
        api: originalModel.api,
        provider: originalModel.provider,
        model: originalModel.id,
        content: [
          {
            type: "thinking",
            thinking: "",
            thinkingSignature: JSON.stringify({
              type: "reasoning",
              id: "rs_old",
              summary: [],
              encrypted_content: "opaque-first-server"
            })
          },
          { type: "text", text: "visible reply" }
        ],
        stopReason: "stop",
        timestamp: 2,
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        }
      }
    ];
    const session = new PiSession({
      baseUrl: provider.baseUrl,
      api: "openai-responses",
      apiKey: "local-key",
      model: "same-name",
      connectionId: changed === "profile" ? "profile-b" : "profile-a",
      supportsReasoningEffort: true,
      thinkingLevel: "low",
      tools: new Map(),
      initialMessages,
      maxErrorRetries: 0
    });
    const result = await session.run("continue");
    assert.equal(result.termination, "completed");
    const sent = JSON.stringify(provider.requests.at(-1).body);
    assert.ok(!sent.includes("opaque-first-server"), "foreign encrypted reasoning must not be replayed");
    assert.ok(sent.includes("remember visible history"));
    assert.ok(sent.includes("visible reply"));
    assert.ok(
      initialMessages[1].content[0].thinkingSignature.includes("opaque-first-server"),
      "original history stays intact"
    );
  });
}
