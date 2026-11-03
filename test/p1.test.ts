import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { createWebTools } from "../src/tools/web-tools.js";
import { TraceRecorder } from "../src/storage/trace-recorder.js";
import { createLoadSkillTool, discoverSkills, skillCatalogPrompt } from "../src/runtime/skill-registry.js";

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "cowork-p1-"));
  try {
    await writeFile(join(root, "sample.txt"), "hello");
    const tools = createBuiltinTools({ rootDirectory: root });
    assert.deepEqual(await tools.get("read_file")?.execute({ path: "sample.txt" }), {
      path: "sample.txt",
      content: "hello"
    });
    await tools.get("apply_patch")?.execute({ path: "sample.txt", oldText: "hello", newText: "hello world" });
    assert.equal(await readFile(join(root, "sample.txt"), "utf8"), "hello world");
    await tools.get("write_file")?.execute({ path: "deliverables/report.md", content: "# report\n" });
    assert.equal(await readFile(join(root, "deliverables", "report.md"), "utf8"), "# report\n");
    await tools
      .get("write_file")
      ?.execute({ path: "context/memory.md", content: "## Goal\nKeep the task state concise.\n" });
    assert.equal(
      await readFile(join(root, "context", "memory.md"), "utf8"),
      "## Goal\nKeep the task state concise.\n"
    );
    await assert.rejects(
      () => tools.get("write_file")!.execute({ path: "context/messages.json", content: "[]" }),
      /framework-managed/
    );
    await assert.rejects(
      () =>
        tools
          .get("apply_patch")!
          .execute({ path: "context/state.json", oldText: "version", newText: "broken" }),
      /framework-managed/
    );
    await assert.rejects(() => tools.get("read_file")!.execute({ path: "../escape" }), /escapes workspace/);
    const command = await tools
      .get("run_command")
      ?.execute({ command: "node", args: ["-e", "console.log(42)"] });
    assert.equal((command as { exitCode: number }).exitCode, 0);

    const skillRoot = join(root, ".pi", "skills", "demo");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Use for demo files.\n---\n\n# Demo\nDo the demo thing.\n"
    );
    const skills = await discoverSkills([join(root, ".pi", "skills")]);
    assert.equal(skills.length, 1);
    assert.match(skillCatalogPrompt(skills), /demo-skill: Use for demo files/);
    const loaded = (await createLoadSkillTool(skills).execute({ name: "demo-skill" })) as {
      content: string;
      directory: string;
    };
    assert.match(loaded.content, /Do the demo thing/);
    assert.equal(loaded.directory, skillRoot);
    await assert.rejects(() => createLoadSkillTool(skills).execute({ name: "missing" }), /unknown skill/);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const target = String(input);
      if (target === "https://google.serper.dev/search") {
        assert.equal((init?.headers as Record<string, string>)["X-API-KEY"], "serper-test-key");
        return fakeResponse(
          JSON.stringify({
            organic: [{ position: 1, title: "Example", link: "https://example.com", snippet: "A result" }]
          }),
          200,
          "application/json"
        );
      }
      return fakeResponse(
        "<html><head><title>Example &amp; Test</title></head><body><h1>Hello</h1><script>ignore()</script><p>World</p></body></html>",
        200,
        "text/html"
      );
    }) as typeof fetch;
    try {
      const web = createWebTools({ serperApiKey: "serper-test-key" });
      const searchResult = await web.get("search")?.execute({ query: "example" });
      assert.match(JSON.stringify(searchResult), /https:\/\/example\.com/);
      const visitResult = await web.get("visit")?.execute({ url: "https://example.com" });
      assert.match(JSON.stringify(visitResult), /Hello/);
      assert.match(JSON.stringify(visitResult), /World/);
      assert.doesNotMatch(JSON.stringify(visitResult), /ignore/);
      await assert.rejects(
        () => web.get("visit")!.execute({ url: "http://127.0.0.1:8080" }),
        /private-network/
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    const shared = await mkdtemp(join(tmpdir(), "cowork-p1-shared-"));
    try {
      await mkdir(join(shared, "agents", "subagents", "s1"), { recursive: true });
      await writeFile(join(shared, "agents", "subagents", "s1", "progress.md"), "tests are green\n");
      const scoped = createBuiltinTools({ rootDirectory: root, workspaceDirectory: shared });
      const tree = await scoped.get("browse_workspace")?.execute({ mode: "tree", depth: 4 });
      assert.match(JSON.stringify(tree), /agents\/subagents\/s1\/progress\.md/);
      const search = await scoped.get("browse_workspace")?.execute({ mode: "search", query: "green" });
      assert.match(JSON.stringify(search), /progress\.md/);
      await assert.rejects(() => scoped.get("read_file")!.execute({ path: "../" }), /escapes workspace/);
    } finally {
      await rm(shared, { recursive: true, force: true });
    }

    const tracePath = join(root, "trace.jsonl");
    const recorder = new TraceRecorder(tracePath);
    await recorder.record({
      traceId: "trace_1",
      kind: "runtime",
      taskId: "task",
      runId: "run",
      payload: { apiKey: "secret", ok: true }
    });
    const trace = await readFile(tracePath, "utf8");
    assert.match(trace, /\[REDACTED\]/);
    assert.doesNotMatch(trace, /secret/);
    console.log("P1 tool/trace tests passed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function fakeResponse(body: string, status: number, contentType: string): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
