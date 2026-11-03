import { confirmApplicationWorkspaceInDom } from "./application-workspace-choice.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { session } from "./live-ui-harness.mjs";

/**
 * The real page against a real Dashboard, clicked through as a person would.
 *
 * Every other UI suite stubs `fetch`, which is what let a real bug through: the
 * stub answers instantly and in request order, so a race between "re-read the
 * strip" and "claim the conversation" cannot happen there. Over real HTTP it
 * does, and the editor covered the conversation for several seconds until a
 * poll corrected it.
 *
 * These are slow by construction — they boot a server and a DOM per test — so
 * this file covers the seams only, not behaviour a stubbed test already pins.
 */

const tabsOf = (ui) => ui.$$("#workbench [data-tab-strip] [data-tab]").map((node) => node.dataset.tab);
const showingConversation = (ui) => !ui.$("#conversation-pane").hidden;

/**
 * Open an application, create a document in it, and save.
 *
 * With no conversation selected the window is standalone, which is the state
 * these tests start from: a person opens an editor before deciding what the
 * work is, and relates it to a conversation afterwards.
 */
async function documentInStandaloneWindow(ui, title = "产品方案.md") {
  await ui.click("#apps-nav", 400);
  await ui.click('#apps-panel [data-create-app="text-editor"]', 600);
  confirmApplicationWorkspaceInDom(ui);
  await ui.waitFor("[data-empty-new]");
  await ui.click("[data-empty-new]", 50);
  await ui.nameDocument(title);
  await ui.type("[data-editor-input]", "# 产品方案\n\n## 目标用户\n研究员。\n", 300);
  await ui.press("[data-editor-input]", "s", { ctrlKey: true }, 900);
}

async function collaborateNew(ui) {
  const application = ui.$$("[data-tab-rail] [data-tab]")[0]?.dataset.tab;
  assert.ok(application, "an application is selected before loading its context");
  await ui.click("[data-app-collaborate]", 200);
  await ui.waitFor("#app-bind-select.is-bound");
  await ui.waitFor('[data-tab-kind="conversation"][aria-selected="true"]');
  assert.equal(showingConversation(ui), true, "returning loads the app and reveals its conversation");
}

test(
  "a document is written, related to a new conversation, and the Agent sees it",
  { timeout: 120000 },
  async (t) => {
    const ui = await session();
    t.after(() => ui.stop());

    await documentInStandaloneWindow(ui);
    // A document tab is named by its document, whoever it belongs to. That it
    // belongs to nobody yet is reported as `standalone`, not encoded in the id.
    assert.ok(
      tabsOf(ui).some((id) => id.startsWith("window:")),
      "the editor opened on its own"
    );

    // Loading uses the composer context menu; no native prompt is involved.
    let askedWhich = 0;
    ui.window.prompt = (question) => {
      if (/对话|编号/.test(String(question))) askedWhich += 1;
      return "1";
    };
    await collaborateNew(ui);
    assert.equal(askedWhich, 0, "it must not ask which conversation to use");

    const { tasks } = await (await fetch(`${ui.base}/api/tasks`)).json();
    const made = tasks.filter((task) => task.taskId !== "workspace");
    assert.equal(made.length, 1, "a conversation was created");

    // The race this pins: `bind-resource` leaves the adopted window active, so
    // re-reading the strip first mounted the editor over the conversation and
    // only a later poll corrected it.
    assert.equal(showingConversation(ui), true, "the person lands in the conversation, immediately");
    await ui.settle(1200);
    assert.equal(showingConversation(ui), true, "and stays there when the next poll arrives");

    // The point of the whole feature: the Agent's next turn knows what is open.
    const context = await (
      await fetch(`${ui.base}/api/tasks/${made[0].taskId}/active-app-context?agentId=main`)
    ).json();
    assert.ok(context.context, "the Agent receives the active application context");
    assert.match(context.rendered, /目标用户/, "including a summary of what the user wrote");
    assert.deepEqual(ui.problems, [], "no uncaught errors anywhere in the flow");
  }
);

test(
  "choosing a binding in the composer leaves the person where they were",
  { timeout: 120000 },
  async (t) => {
    const ui = await session();
    t.after(() => ui.stop());

    await documentInStandaloneWindow(ui, "方案.md");
    ui.window.prompt = () => "1";
    await collaborateNew(ui);
    assert.equal(showingConversation(ui), true);

    // Binding is a statement about what the next message refers to, not a
    // navigation: it must not pull the editor over the composer being typed into.
    await ui.click("#app-bind-select", 400);
    const option = ui
      .$$("#app-bind-menu [data-bind-instance]")
      .find((row) => !/不加载/.test(row.textContent));
    assert.ok(option, "the conversation's own window is offered");
    await ui.click(option, 800);

    assert.equal(showingConversation(ui), true, "the conversation stays in front");
    assert.match(ui.$(".app-bind-name").textContent, /方案/, "and the control reports the binding");
    await ui.settle(1200);
    assert.equal(showingConversation(ui), true, "still in front after the next poll");
    assert.deepEqual(ui.problems, []);
  }
);

test("the editor's 打开 menu actually opens the document that is clicked", { timeout: 120000 }, async (t) => {
  // The bug this pins: `createApplicationApi` declared an `openResourceInTab`
  // callback that `app.js` never supplied, so `api.openResourceInTab?.()`
  // optional-chained into nothing and clicking a document did nothing at all.
  // The stubbed UI test for this menu passed the whole time — it asserted the
  // list renders and that the handler is wired, never that a click arrives
  // anywhere.
  const ui = await session();
  t.after(() => ui.stop());

  await documentInStandaloneWindow(ui, "第一份.md");
  ui.window.prompt = () => "1";
  await collaborateNew(ui);
  const { tasks } = await (await fetch(`${ui.base}/api/tasks`)).json();
  const taskId = tasks.find((task) => task.taskId !== "workspace").taskId;

  // A second document referenced by the *window's own* conversation, which is
  // what its 打开 menu lists. The window was opened standalone, so that is the
  // shared workspace rather than the conversation the first document was
  // related to — the menu shows what its own conversation references.
  // The conversation the open document belongs to. A document tab names no
  // conversation, so it is read from the referencers the strip reports.
  const openTab = (await (await fetch(`${ui.base}/api/workbench/tabs`)).json()).tabs.find(
    (tab) => tab.kind === "application"
  );
  const windowTask = openTab.accessTaskId;
  await fetch(`${ui.base}/api/tasks/${windowTask}/resources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "text/markdown", title: "第二份.md", initialContent: "# 第二份\n" })
  });
  await ui.settle(600);

  const editorTab = tabsOf(ui).find((id) => id.startsWith("window:"));
  await ui.click(`[data-tab="${editorTab}"]`, 700);
  await ui.click("[data-editor-open]", 700);

  const rows = ui.$$("[data-editor-open-sheet] [data-open]");
  assert.equal(rows.length, 1, "the other document is listed");
  const before = tabsOf(ui).length;
  await ui.click(rows[0]);
  // Real HTTP/resource loading can outlast a fixed sleep under full-suite load.
  await ui.waitFor(`#workbench [data-tab-strip] [data-tab^="window:"]:not([data-tab="${editorTab}"])`);

  assert.ok(tabsOf(ui).length > before, "clicking it opens it, rather than silently doing nothing");
  assert.ok(
    tabsOf(ui).some((id) => id !== editorTab && id.startsWith("window:")),
    "the second document has its own tab"
  );
  assert.deepEqual(ui.problems, []);
});

test(
  "a user edit after binding reaches the Agent as a change it has not seen",
  { timeout: 120000 },
  async (t) => {
    const ui = await session();
    t.after(() => ui.stop());

    await documentInStandaloneWindow(ui, "方案.md");
    ui.window.prompt = () => "1";
    await collaborateNew(ui);
    const { tasks } = await (await fetch(`${ui.base}/api/tasks`)).json();
    const taskId = tasks.find((task) => task.taskId !== "workspace").taskId;

    // Back to the editor, change a sentence, save.
    const editorTab = tabsOf(ui).find((id) => id.startsWith("window:"));
    await ui.click(`[data-tab="${editorTab}"]`, 600);
    const box = ui.$("[data-editor-input]");
    await ui.type("[data-editor-input]", box.value.replace("研究员。", "研究员和产品经理。"), 300);
    await ui.press("[data-editor-input]", "s", { ctrlKey: true }, 900);

    const context = await (
      await fetch(`${ui.base}/api/tasks/${taskId}/active-app-context?agentId=main`)
    ).json();
    const changes = context.context?.changesSinceAgentRevision ?? [];
    assert.ok(changes.length > 0, "the Agent is told what the user changed");
    assert.match(JSON.stringify(changes), /产品经理/, "and the summary names the actual edit");
    assert.deepEqual(ui.problems, []);
  }
);

test(
  "an independent txt loads into a new conversation without loading its sibling instance",
  { timeout: 120000 },
  async (t) => {
    // Both defects this pins were reported together and share one cause: relating
    // a standalone editor to a conversation moved only the document in front. The
    // rest stayed in the shared workspace, so a new conversation could not reach
    // them and the editor's 打开 menu — which lists the owning Task's resources —
    // came back empty.
    const ui = await session();
    t.after(() => ui.stop());

    // An editor opened on its own, holding two documents.
    await documentInStandaloneWindow(ui, "笔记.txt");
    await ui.click("[data-editor-open]", 700);
    const createRow = ui.$("[data-editor-open-sheet] [data-open-new]");
    assert.ok(createRow, "the open menu offers creating another document");
    await ui.click(createRow, 50);
    await ui.nameDocument("附录.txt", 1200);

    const originalTabs = (await (await fetch(`${ui.base}/api/workbench/tabs`)).json()).tabs;
    const siblings = originalTabs.filter(
      (tab) => tab.kind === "application" && ["笔记.txt", "附录.txt"].includes(tab.title)
    );
    assert.equal(siblings.length, 2, "both standalone documents have live tabs");
    const original = siblings[0];
    assert.ok(original.accessTaskId, "the standalone editor has an owning Task");
    assert.ok(original.workspaceRoot, "the standalone editor retains its physical root");
    for (const sibling of siblings) {
      assert.equal(sibling.accessTaskId, original.accessTaskId);
      assert.equal(sibling.workspaceRoot, original.workspaceRoot);
    }

    // A brand-new conversation, which has no task of its own yet.
    await ui.click("#new-conversation", 800);
    assert.equal(ui.window.location.hash, "");
    assert.deepEqual(ui.historyCalls, [], "ordinary new conversations do not enter goal navigation");
    assert.match(ui.$("[data-tab-strip]").textContent, /新对话/);

    // The composer's binding control must be able to reach that editor.
    await ui.click("#app-bind-select", 500);
    const option = ui
      .$$("#app-bind-menu [data-bind-instance]")
      .find((row) => /笔记|附录/.test(row.textContent));
    assert.ok(option, "an unattached document is offered to a conversation being composed");
    const selectedTitle = option.querySelector(".model-option-name").textContent;
    await ui.click(option, 2000);

    // The draft became a real conversation with only the selected document loaded.
    const { tasks } = await (await fetch(`${ui.base}/api/tasks`)).json();
    const real = tasks.filter((task) => task.taskId !== "workspace");
    assert.equal(real.length, 1, "one conversation, not a second one beside the draft");
    const resources = await (await fetch(`${ui.base}/api/tasks/${real[0].taskId}/resources`)).json();
    // Compared as a set: the order resources come back in is not what this pins.
    assert.deepEqual(
      new Set(resources.resources.map((entry) => entry.title)),
      new Set([selectedTitle]),
      "only the selected instance is loaded into this conversation"
    );
    const selected = siblings.find((tab) => tab.title === selectedTitle);
    assert.ok(selected, "the selected instance belongs to the original siblings");
    assert.deepEqual(
      resources.resources.map((resource) => resource.resourceId),
      [selected.resourceId],
      "the conversation loads exactly the selected resource identity"
    );
    const boundTabs = (await (await fetch(`${ui.base}/api/workbench/tabs`)).json()).tabs;
    for (const sibling of siblings) {
      const current = boundTabs.find((tab) => tab.resourceId === sibling.resourceId);
      assert.ok(current, "each original sibling still has a live tab");
      assert.equal(current.workspaceRoot, original.workspaceRoot, "binding preserves the original root");
    }
    // Binding a conversation keeps both originals available in their durable holding Task.
    const left = await (
      await fetch(`${ui.base}/api/tasks/${encodeURIComponent(original.accessTaskId)}/resources`)
    ).json();
    assert.deepEqual(
      new Set(left.resources.map((resource) => resource.title)),
      new Set(["笔记.txt", "附录.txt"]),
      "both original documents remain independently available"
    );

    // And the Agent's next turn can see the one the person was looking at.
    const context = await (
      await fetch(`${ui.base}/api/tasks/${real[0].taskId}/active-app-context?agentId=main`)
    ).json();
    assert.ok(context.context, "the conversation is bound to the adopted document");
    assert.doesNotMatch(
      ui.$("[data-tab-strip]").textContent,
      /新对话/,
      "the draft tab gave way to the real conversation"
    );
    assert.deepEqual(ui.problems, []);
  }
);

test(
  "a document created inside one conversation is reachable from a new one",
  { timeout: 120000 },
  async (t) => {
    // Loading a document into one conversation must not hide it from another.
    // The applications panel creates an independent instance; the composer
    // explicitly loads it into the original conversation before crossing to a new one.
    const ui = await session();
    t.after(() => ui.stop());

    // This test needs an existing conversation, not an inference attempt. With
    // no model configured, Send now opens settings instead of creating a task.
    // Create the real fixture through HTTP and select it through the page.
    const originTaskId = "origin-conversation";
    const created = await fetch(`${ui.base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: originTaskId, goal: "第一个对话" })
    });
    assert.equal(created.status, 201);
    await ui.click(`#project-list [data-task="${originTaskId}"]`);
    await ui.waitFor(`[data-tab="conversation:${originTaskId}"][aria-selected="true"]`);
    await ui.click("#apps-nav", 400);
    await ui.click('#apps-panel [data-create-app="text-editor"]');
    confirmApplicationWorkspaceInDom(ui);
    await ui.waitFor("[data-empty-new]");
    // The empty editor becomes clickable before opening/activation finishes.
    // Naming while those writes are still pending can race a stale activation.
    await ui.waitFor('[data-tab-kind="application"][aria-selected="true"]');
    await ui.click("[data-empty-new]", 50);
    await ui.nameDocument("笔记.txt");
    await ui.type("[data-editor-input]", "笔记的内容\n", 200);
    await ui.press("[data-editor-input]", "s", { ctrlKey: true }, 900);

    assert.equal(showingConversation(ui), false, "application entry opens an independent instance");
    await ui.click(`#project-list [data-task="${originTaskId}"]`);
    await ui.waitFor(`[data-tab="conversation:${originTaskId}"][aria-selected="true"]`);
    await ui.click("#app-bind-select", 500);
    const originBinding = ui
      .$$("#app-bind-menu [data-bind-instance]")
      .find((row) => /笔记/.test(row.textContent));
    assert.ok(originBinding, "the original conversation can explicitly load the independent document");
    await ui.click(originBinding, 1200);
    await ui.waitFor("#app-bind-select.is-bound");
    const { tasks: before } = await (await fetch(`${ui.base}/api/tasks`)).json();
    const origin = before.find((task) => task.taskId === originTaskId);
    assert.ok(origin, "the original conversation still exists");
    const owned = await (await fetch(`${ui.base}/api/tasks/${origin.taskId}/resources`)).json();
    assert.deepEqual(
      owned.resources.map((entry) => entry.title),
      ["笔记.txt"],
      "the original conversation explicitly loads the document"
    );

    // A brand-new conversation must be able to reach it.
    await ui.click("#new-conversation", 900);
    assert.equal(ui.window.location.hash, "");
    assert.deepEqual(ui.historyCalls, [], "cross-conversation document loading leaves the URL alone");
    await ui.click("#app-bind-select", 600);
    const option = ui.$$("#app-bind-menu [data-bind-instance]").find((row) => /笔记/.test(row.textContent));
    assert.ok(option, "the document is offered from a conversation that does not own it");
    await ui.click(option);

    // Selecting it moves it here, rather than doing nothing: from a draft there
    // is no task to switch, and the control used to return early.
    // Binding crosses several HTTP writes. Wait for the observable references,
    // rather than assuming a fixed delay is enough under native-test CPU load.
    let holder = [];
    const deadline = Date.now() + 20_000;
    do {
      const { tasks: after } = await (await fetch(`${ui.base}/api/tasks`)).json();
      holder = [];
      for (const task of after.filter((entry) => entry.taskId !== "workspace")) {
        const resources = await (await fetch(`${ui.base}/api/tasks/${task.taskId}/resources`)).json();
        if (resources.resources.some((entry) => entry.title === "笔记.txt")) holder.push(task.taskId);
      }
      if (holder.length === 2) break;
      await ui.settle(100);
    } while (Date.now() < deadline);
    // Referenced from both, which is the point: two conversations, two agents,
    // one document. It used to move, so the conversation that created it lost it.
    assert.equal(holder.length, 2, "both conversations reference the document");
    assert.ok(holder.includes(origin.taskId), "the conversation that created it keeps it");

    const context = await (
      await fetch(`${ui.base}/api/tasks/${holder[0]}/active-app-context?agentId=main`)
    ).json();
    assert.ok(context.context, "the new conversation is bound to it, so the Agent sees it");
    assert.match(context.rendered, /笔记/);
    assert.deepEqual(ui.problems, []);
  }
);

test(
  "txt creation, rename, clearing, undo and reopening survive the real HTTP seam without native prompts",
  { timeout: 120000 },
  async (t) => {
    const ui = await session();
    t.after(() => ui.stop());
    ui.window.prompt = () => {
      throw new Error("prompt() is not supported");
    };
    await documentInStandaloneWindow(ui, "真实测试.txt");
    const tabs = await (await fetch(`${ui.base}/api/workbench/tabs`)).json();
    const original = tabs.tabs.find((tab) => tab.kind === "application");
    assert.ok(original.accessTaskId, "the editor exposes its owning Task");
    assert.ok(original.workspaceRoot, "the editor exposes its physical root");
    const { resourceId, accessTaskId } = original;
    const read = async () => {
      const response = await fetch(
        `${ui.base}/api/tasks/${encodeURIComponent(accessTaskId)}/resources/${encodeURIComponent(resourceId)}`
      );
      assert.equal(response.status, 200, "the original resource remains accessible");
      return response.json();
    };
    assert.equal((await read()).resource.kind, "text/plain", "txt is a plain text resource");
    assert.match(ui.$("[data-editor-download]").getAttribute("href"), /format=text$/);

    await ui.click("[data-editor-rename]", 50);
    await ui.nameDocument("中文重命名.txt");
    assert.match(ui.$("[data-tab-strip]").textContent, /中文重命名/);
    await ui.type("[data-editor-input]", "", 50);
    await ui.press("[data-editor-input]", "s", { ctrlKey: true });
    assert.equal((await read()).snapshot.content, "", "clearing is saved");
    await ui.click("[data-editor-undo]", 600);
    const restored = (await read()).snapshot.content;
    assert.match(restored, /研究员/);
    assert.equal(ui.$("[data-editor-input]").value, restored, "undo updates the screen too");
    const revision = (await read()).resource.revision;
    await ui.settle(900);
    assert.equal((await read()).resource.revision, revision, "autosave cannot reverse undo");

    await collaborateNew(ui);
    assert.equal(ui.$("#workspace-artifact-count").textContent, "1", "resource rows are counted");
    const editorTab = tabsOf(ui).find((id) => id.startsWith("window:"));
    await ui.click(`[data-tab="${editorTab}"]`, 500);
    await ui.click(`[data-close-tab="${editorTab}"]`, 500);
    await ui.click("#apps-nav", 400);
    await ui.click(`[data-open-resource="${resourceId}"]`, 800);
    assert.equal(ui.$("[data-editor-input]").value, restored, "closed documents reopen with saved content");
    const reopenedTabs = (await (await fetch(`${ui.base}/api/workbench/tabs`)).json()).tabs;
    const reopened = reopenedTabs.find((tab) => tab.kind === "application" && tab.resourceId === resourceId);
    assert.ok(reopened, "the same resource is reopened");
    assert.equal(reopened.workspaceRoot, original.workspaceRoot, "reopening preserves the original root");
    assert.equal((await read()).snapshot.content, restored, "the original holding resource retains undo");
    assert.deepEqual(ui.problems, []);
  }
);

test(
  "choosing a previously related conversation loads the displayed instance and polling preserves it",
  { timeout: 120000 },
  async (t) => {
    const ui = await session();
    t.after(() => ui.stop());
    await documentInStandaloneWindow(ui, "主文档.txt");
    await collaborateNew(ui);
    const editorTab = tabsOf(ui).find((id) => id.startsWith("window:"));
    await ui.click(`[data-tab="${editorTab}"]`, 500);
    await ui.click("[data-editor-open]", 400);
    await ui.click("[data-open-new]", 50);
    await ui.nameDocument("另一份.txt", 1000);
    const otherTab = tabsOf(ui).find((id) => id.startsWith("window:") && id !== editorTab);
    await ui.click(`[data-tab="${editorTab}"]`, 500);
    const { tasks } = await (await fetch(`${ui.base}/api/tasks`)).json();
    const task = tasks.find((entry) => entry.taskId !== "workspace");
    await collaborateNew(ui);

    assert.equal(showingConversation(ui), true);
    assert.equal(ui.$(".app-bind-name").textContent, "主文档.txt");
    const start = ui.requests.length;
    await ui.settle(3800);
    assert.equal(ui.$(".app-bind-name").textContent, "主文档.txt");
    assert.equal(
      ui.requests.slice(start).filter((request) => request === "POST /api/workbench/tabs").length,
      0,
      "polling and rendering are reads, not binding writes"
    );
    assert.ok(otherTab);
    assert.deepEqual(ui.problems, []);
  }
);
