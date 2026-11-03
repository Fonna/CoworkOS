import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createScienceInstallation } from "../web/assets/controllers/science-installation.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let index = 0; index < 16; index++) await Promise.resolve();
};
const absent = () => ({ general: { state: "absent" }, chemistry: { state: "absent" } });

function fixture(t, request) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { window, document } = parseHTML('<section id="installation"></section>');
  const container = document.querySelector("#installation");
  const selected = [];
  const drafts = { general: "/fixture/general-python", chemistry: "/fixture/chemistry-python" };
  const controller = createScienceInstallation({
    container,
    request,
    interpreter: (target) => drafts[target],
    useEnvironment: (field, python) => {
      selected.push({ field, python });
    }
  });
  t.after(() => {
    controller.close();
    t.mock.timers.reset();
  });
  const card = (target) => container.querySelector(`[data-environment="${target}"]`);
  const button = (target, action) => card(target).querySelector(`[data-installation-${action}]`);
  const click = (target, action) =>
    button(target, action).dispatchEvent(new window.Event("click", { bubbles: true }));
  const label = (target) => card(target).querySelector("[data-installation-state]").textContent;
  return { controller, container, selected, drafts, card, button, click, label };
}

test("a failed action resumes authoritative polling without letting its stale GET overwrite progress", async (t) => {
  const oldPoll = deferred();
  const installing = {
    general: { state: "installing", phase: "installing_dependencies" },
    chemistry: { state: "absent" }
  };
  let reads = 0;
  const requests = [];
  const f = fixture(t, async (method, body, path) => {
    requests.push({ method, body, path });
    if (method === "POST") throw new Error("fixture installation request failed");
    if (++reads === 1) return structuredClone(installing);
    if (reads === 2) return oldPoll.promise;
    return {
      general: { state: "ready", installedPython: "/managed/general/python" },
      chemistry: { state: "absent" }
    };
  });
  f.controller.availability(true, {});
  f.controller.open();
  await flush();
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 2, "the next progress poll is genuinely in flight");
  f.click("chemistry", "start");
  await flush();
  assert.equal(reads, 3, "POST failure must start a fresh progress read");
  assert.match(f.label("general"), /已安装并通过检查/);
  assert.equal(f.button("general", "use").hidden, false);
  assert.match(
    f.container.querySelector("[data-installation-error]").textContent,
    /fixture installation request failed/
  );
  oldPoll.resolve(structuredClone(installing));
  await flush();
  assert.match(
    f.label("general"),
    /已安装并通过检查/,
    "the earlier GET cannot restore its obsolete installing state"
  );
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(reads, 3, "a terminal environment does not keep polling");
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  assert.deepEqual(f.selected, [], "progress updates never select an interpreter");
});

test("a successful POST finishing after close and reopen refreshes the current page and continues polling", async (t) => {
  const post = deferred();
  let state = absent(),
    reads = 0;
  const f = fixture(t, async (method) => {
    if (method === "POST") return post.promise;
    reads++;
    return structuredClone(state);
  });
  f.controller.availability(true, {});
  f.controller.open();
  await flush();
  f.click("general", "start");
  await flush();
  assert.equal(f.button("general", "start").disabled, true);
  f.controller.close();
  f.controller.open();
  await flush();
  assert.equal(reads, 2);
  assert.match(f.label("general"), /尚未安装/);
  state.general = { state: "installing", phase: "creating_venv" };
  post.resolve(structuredClone(state.general));
  await flush();
  assert.equal(reads, 3, "the old action triggers a read for the reopened page");
  assert.match(f.label("general"), /正在创建独立环境/);
  assert.equal(f.button("general", "cancel").hidden, false);
  state.general = { state: "ready", installedPython: "/managed/general/python" };
  t.mock.timers.tick(1000);
  await flush();
  assert.equal(reads, 4);
  assert.match(f.label("general"), /已安装并通过检查/);
  assert.equal(f.button("general", "use").disabled, false);
  assert.deepEqual(f.selected, []);
});

test("installation selection, explicit reinstall and cancellation preserve drafts and honor locked fields", async (t) => {
  const requests = [];
  let state = absent(),
    reads = 0;
  const installed = "/managed/general/python";
  const f = fixture(t, async (method, body, path) => {
    requests.push({ method, body, path });
    if (method === "GET") {
      reads++;
      return structuredClone(state);
    }
    state[body.target] = {
      ...state[body.target],
      state: path === "/cancel" ? "cancelled" : "installing",
      phase: "creating_venv"
    };
    return structuredClone(state[body.target]);
  });
  assert.equal(
    f.button("general", "start").disabled,
    true,
    "settings must load before installation becomes available"
  );
  f.controller.availability(true, {});
  f.controller.open();
  await flush();
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 0, "opening only reads metadata");
  f.click("general", "start");
  assert.equal(
    f.button("general", "start").disabled,
    true,
    "duplicate clicks are disabled while the request is pending"
  );
  await flush();
  assert.deepEqual(
    requests.find((entry) => entry.method === "POST"),
    {
      method: "POST",
      body: { target: "general", pythonExecutable: "/fixture/general-python" },
      path: "/install"
    }
  );
  state.general = { state: "ready", installedPython: installed };
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(f.selected, []);
  assert.equal(f.drafts.general, "/fixture/general-python", "completion preserves the current draft");
  f.controller.availability(true, { pythonExecutable: true });
  assert.equal(f.button("general", "use").disabled, true);
  f.click("general", "use");
  assert.deepEqual(
    f.selected,
    [],
    "a managed interpreter cannot be replaced through synthetic events either"
  );
  f.controller.availability(true, {});
  f.click("general", "use");
  assert.deepEqual(f.selected, [{ field: "pythonExecutable", python: installed }]);
  f.click("general", "start");
  await flush();
  assert.deepEqual(requests.filter((entry) => entry.method === "POST").at(-1).body, {
    target: "general",
    pythonExecutable: "/fixture/general-python",
    reinstall: true
  });
  f.click("general", "cancel");
  await flush();
  assert.deepEqual(requests.filter((entry) => entry.method === "POST").at(-1), {
    method: "POST",
    body: { target: "general" },
    path: "/cancel"
  });
  assert.match(f.label("general"), /安装已取消.*已有环境仍可使用/);
  assert.equal(f.button("general", "use").hidden, false);
  assert.equal(f.drafts.general, "/fixture/general-python");
  const beforeClose = reads;
  f.controller.close();
  t.mock.timers.tick(10_000);
  await flush();
  assert.equal(reads, beforeClose, "closing stops UI polling without sending cancellation");
  assert.equal(requests.filter((entry) => entry.path === "/cancel").length, 1);
});
