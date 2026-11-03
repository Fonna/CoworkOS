import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { importArtifactFile } from "../web/assets/workbench/file-import.js";
import { createApplicationApi } from "../web/assets/workbench/api.js";

const needsConversion = () => Object.assign(new Error("需要转换文件"), { code: "unsupported_resource_kind" });

test("reopening an imported artifact reuses it before reading or converting its bytes", async (t) => {
  const calls = [];
  const existing = { reused: true, resource: { resourceId: "res_original" } };
  t.mock.method(globalThis, "fetch", async () => assert.fail("已有文档不应重新读取源文件"));
  const input = {
    taskId: "task-a",
    artifact: { relativePath: "deck.pptx", mimeType: "pptx" },
    catalog: [{ appType: "pptist", fileImportFormats: [{ mimeType: "pptx" }] }],
    registry: { pptist: { importFile: async () => assert.fail("已有文档不应重新转换") } },
    api: {
      importArtifact: async (...args) => {
        calls.push(args);
        return existing;
      }
    }
  };
  assert.equal(await importArtifactFile(input), existing);
  assert.equal(await importArtifactFile(input), existing);
  assert.deepEqual(calls, [
    ["task-a", "deck.pptx"],
    ["task-a", "deck.pptx"]
  ]);
});

test("an artifact lookup failure does not fall through to conversion", async (t) => {
  const unavailable = Object.assign(new Error("服务不可用"), { code: "request_failed" });
  t.mock.method(globalThis, "fetch", async () => assert.fail("失败后不应读取源文件"));
  await assert.rejects(
    importArtifactFile({
      taskId: "task-a",
      artifact: { relativePath: "deck.pptx", mimeType: "pptx" },
      catalog: [{ appType: "pptist", fileImportFormats: [{ mimeType: "pptx" }] }],
      registry: { pptist: { importFile: async () => assert.fail("失败后不应转换") } },
      api: {
        importArtifact: async () => {
          throw unavailable;
        }
      }
    }),
    (error) => error === unavailable
  );
});

test("converted artifacts retain their indexed source identity and hash", async (t) => {
  const calls = [];
  const artifact = {
    relativePath: "演示 空格 & #.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sha256: "stale-task-detail-sha256",
    size: 4
  };
  const content = { slides: [{ id: "slide-original", elements: [] }] };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    if (options?.method === "POST") {
      return JSON.parse(options.body).initialContent
        ? Response.json({ reused: false, resource: { resourceId: "res_original" } })
        : Response.json(
            { error: { code: "unsupported_resource_kind", message: "需要转换文件" } },
            { status: 400 }
          );
    }
    return new Response("pptx", { headers: { "content-type": artifact.mimeType } });
  });
  const result = await importArtifactFile({
    taskId: "task-a",
    artifact,
    catalog: [
      {
        appType: "pptist",
        fileImportFormats: [{ mimeType: artifact.mimeType, resourceKind: "presentation/pptist+json" }]
      }
    ],
    registry: {
      pptist: {
        importFile: async (file) => {
          assert.equal(file.name, artifact.relativePath);
          assert.equal(await file.text(), "pptx");
          return { title: "演示", content };
        }
      }
    },
    api: createApplicationApi()
  });
  assert.equal(result.reused, false);
  assert.deepEqual(JSON.parse(calls[0].options.body), { fromArtifact: artifact.relativePath });
  assert.equal(calls[2].url, "/api/tasks/task-a/resources");
  assert.deepEqual(JSON.parse(calls[2].options.body), {
    fromArtifact: artifact.relativePath,
    artifactSha256: createHash("sha256").update("pptx").digest("hex"),
    appType: "pptist",
    kind: "presentation/pptist+json",
    title: "演示",
    initialContent: content
  });
});

test("an artifact conversion failure does not create a resource", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async () => new Response("invalid pptx"));
  await assert.rejects(
    importArtifactFile({
      taskId: "task-a",
      artifact: { relativePath: "broken.pptx", mimeType: "pptx" },
      catalog: [{ appType: "pptist", fileImportFormats: [{ mimeType: "pptx" }] }],
      registry: {
        pptist: {
          importFile: async () => {
            throw new Error("无法解析 PPTX");
          }
        }
      },
      api: {
        importArtifact: async (...args) => {
          calls.push(args);
          throw needsConversion();
        }
      }
    }),
    /无法解析 PPTX/
  );
  assert.deepEqual(calls, [["task-a", "broken.pptx"]]);
});
