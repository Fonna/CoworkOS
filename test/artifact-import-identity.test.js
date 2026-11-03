import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import PptxGenJS from "pptxgenjs";
import { startDashboard } from "./dashboard-fixture.mjs";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";

async function fixture(t) {
  const d = await startDashboard();
  t.after(() => d.stop());
  const api = async (path, body, status = 200) => {
    const response = await fetch(d.base + path, {
      ...(body === undefined
        ? {}
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000)
    });
    const value = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    return value;
  };
  await api("/api/tasks", { taskId: "chat", projectId: d.projectId, goal: "重复打开同一个产出物" }, 201);
  const store = new LocalWorkspaceStore(d.workspaceRoot);
  const publish = (relativePath, content) =>
    store.publishArtifact({ taskId: "chat", runId: "run", producerAgentId: "main", relativePath, content });
  const open = (body, status = 201) => api("/api/tasks/chat/resources", body, status);
  return { d, api, publish, open };
}

test("ordinary artifact imports serialize concurrent opens and preserve edits through restart", async (t) => {
  const { d, api, publish, open } = await fixture(t);
  await publish("report.txt", "original");
  const opened = await Promise.all(Array.from({ length: 4 }, () => open({ fromArtifact: "report.txt" })));
  const resourceId = opened[0].resource.resourceId;
  assert.ok(opened.every((entry) => entry.resource.resourceId === resourceId));
  assert.equal(opened.filter((entry) => entry.reused).length, 3);
  await api(`/api/tasks/chat/resources/${resourceId}/operations`, {
    appType: "text-editor",
    operationType: "text.replace",
    operationId: "edit-copy",
    baseRevision: 0,
    payload: { from: 0, to: 8, text: "edited copy" }
  });
  await d.restart({ newPort: true });
  const reopened = await open({ fromArtifact: "report.txt" });
  assert.equal(reopened.resource.resourceId, resourceId);
  assert.equal(reopened.snapshot.content, "edited copy");
  assert.equal((await api("/api/tasks/chat/resources")).resources.length, 1);
  const detail = await api("/api/tasks/chat");
  assert.equal(detail.applications.deliverables.length, 1);
  assert.equal(detail.applications.deliverables[0].resourceId, resourceId);
  assert.equal(detail.applications.deliverables[0].files[0].relativePath, "report.txt");
  assert.equal(detail.artifacts.length, 1);
  const file = join(d.workspaceRoot, "chat", "artifacts", "report.txt");
  assert.equal(await readFile(file, "utf8"), "original");
  await publish("other/report.txt", "original");
  const other = await open({ fromArtifact: "other/report.txt" });
  assert.notEqual(other.resource.resourceId, resourceId);
  await writeFile(file, "replacement");
  const replacement = await open({ fromArtifact: "report.txt" });
  assert.notEqual(replacement.resource.resourceId, resourceId);
  assert.equal(replacement.snapshot.content, "replacement");
  assert.equal(
    (await open({ fromArtifact: "report.txt" })).resource.resourceId,
    replacement.resource.resourceId
  );
  assert.equal((await api(`/api/tasks/chat/resources/${resourceId}`)).snapshot.content, "edited copy");
});

test("converted PPTX imports validate their file version and reuse one editable resource", async (t) => {
  const { d, api, publish, open } = await fixture(t);
  const pptx = new PptxGenJS();
  pptx.addSlide();
  const bytes = await pptx.write({ outputType: "nodebuffer" });
  await publish("blank.pptx", bytes);
  const input = {
    fromArtifact: "blank.pptx",
    artifactSha256: createHash("sha256").update(bytes).digest("hex"),
    appType: "pptist",
    kind: "presentation/pptist+json",
    title: "blank",
    initialContent: { slides: [{ id: "blank", elements: [], remark: "converted content" }] }
  };
  const opened = await Promise.all([open(input), open(input)]);
  const resourceId = opened[0].resource.resourceId;
  assert.equal(opened[1].resource.resourceId, resourceId);
  assert.equal(opened.filter((entry) => entry.reused).length, 1);
  await d.restart({ newPort: true });
  const reopened = await open({ fromArtifact: "blank.pptx" });
  assert.equal(reopened.resource.resourceId, resourceId);
  assert.equal(reopened.snapshot.content.slides[0].remark, "converted content");
  assert.equal((await api("/api/tasks/chat/resources")).resources.length, 1);
  const conflict = await open({ ...input, artifactSha256: "0".repeat(64) }, 409);
  assert.equal(conflict.error.code, "source_file_conflict");
  await publish("other.pptx", bytes);
  const invalid = await open(
    { ...input, fromArtifact: "other.pptx", appType: "text-editor", kind: "text/plain" },
    422
  );
  assert.equal(invalid.error.code, "unsupported_resource_kind");
  assert.equal((await api("/api/tasks/chat/resources")).resources.length, 1);
  assert.deepEqual(await readFile(join(d.workspaceRoot, "chat", "artifacts", "blank.pptx")), bytes);
});
