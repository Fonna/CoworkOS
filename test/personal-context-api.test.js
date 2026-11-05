import assert from "node:assert/strict";
import { test } from "node:test";
import { startDashboard } from "./dashboard-fixture.mjs";
import { PersonalContextStore } from "../dist/src/runtime/personal-context-store.js";
import { PersonalContextChat } from "../dist/src/runtime/personal-context-chat.js";
import { join } from "node:path";

test(
  "local management rejects foreign origins/stale versions and manages sensitive records even while disabled",
  { timeout: 45000 },
  async (t) => {
    const dashboard = await startDashboard();
    t.after(dashboard.stop);
    const store = new PersonalContextStore({
      path: join(dashboard.root, "home", "personal-context", "context.json")
    });
    await store.transaction((doc) => {
      doc.settings.sensitiveEnabled = true;
    });
    const chat = new PersonalContextChat({
      store,
      workspaceRoot: dashboard.workspaceRoot,
      taskId: "a",
      runId: "r",
      assess: async () => ({ authorized: true, sensitive: true, statement: "self_report" })
    });
    chat.setSource({ messageId: "m", receivedAt: new Date().toISOString(), text: "请保存我的个人会议安排" });
    const saved = await chat.tool.execute({
      action: "save",
      context: {
        kind: "arrangement",
        status: "confirmed",
        title: "PRIVATE_MEETING",
        content: "private body",
        quote: "请保存我的个人会议安排",
        visibility: "user",
        observedAt: new Date().toISOString()
      }
    });
    await store.transaction((doc) => {
      doc.settings.sensitiveEnabled = false;
      doc.generation++;
      doc.snapshotRevision++;
    });
    const url = `${dashboard.base}/api/personal-context`;
    assert.equal((await fetch(url, { headers: { origin: "https://foreign.invalid" } })).status, 403);
    const view = await (await fetch(url)).json();
    assert.equal(view.settings.enabled, false);
    assert.equal(view.records[0].content, "private body");
    assert.ok(!JSON.stringify(view).includes(dashboard.root.replaceAll("\\", "\\\\")));
    const post = (change, basis = view) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ basis: basis.basis, snapshotRevision: basis.snapshotRevision, change })
      });
    const cancelled = await post({ action: "cancel", id: saved.id, revision: 1 });
    assert.equal(cancelled.status, 200);
    const updated = await cancelled.json();
    assert.equal(updated.records[0].status, "cancelled");
    assert.equal((await post({ action: "forget", id: saved.id, revision: 1 })).status, 409);
    const deletion = await post({ action: "forget", id: saved.id, revision: 2 }, updated);
    assert.equal(deletion.status, 200);
    assert.equal((await deletion.json()).records.length, 0);
    assert.doesNotMatch(JSON.stringify(await store.read()), /private body|PRIVATE_MEETING/);
    assert.equal(
      (await post({ action: "settings", settings: { enabled: true }, injected: true })).status,
      400
    );
    await dashboard.restart();
    assert.equal((await (await fetch(`${dashboard.base}/api/personal-context`)).json()).records.length, 0);
  }
);
