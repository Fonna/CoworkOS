import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserUse } from "../dist/src/gui/browser-use.js";
import { browserFixture, browserTestOptions } from "./browser-fixture.mjs";
import { CuaScriptController } from "../dist/src/tools/cua-script.js";

const result = (details) => ({ content: [{ type: "text", text: JSON.stringify(details) }], details });
for (const surface of ["browser", "computer"])
  test(`${surface} SDK wait timeout rejects before the subsequent input; tolerance is explicit`, async (t) => {
    const vm = new CuaScriptController();
    t.after(() => vm.dispose());
    const calls = [];
    const dispatch = async (name) => {
      calls.push(name);
      return result({ status: "timeout", observation: { observationId: "fresh", pageId: "owned" } });
    };
    const binding = surface === "browser" ? "cua.browser.use('owned')" : "cua.computer.use('owned')";
    const condition =
      surface === "browser"
        ? "{type:'url',url:'https://fixture.invalid'}"
        : "{type:'accessibility_text',text:'Ready',state:'present'}";
    const output = await vm.execute(
      {
        code: `state.target=${binding}; await state.target.wait(${condition}); await state.target.act({type:'activate'});`
      },
      dispatch
    );
    assert.equal(output.isError, true);
    assert.equal(output.details.errorCode, "wait_timeout");
    assert.deepEqual(calls, [`${surface}_wait`]);
    const tolerant = await vm.execute(
      { code: `const target=${binding}; return await target.wait(${condition},{allowTimeout:true});` },
      dispatch
    );
    assert.equal(tolerant.isError, undefined);
    assert.equal(tolerant.details.value.status, "timeout");
  });

test("SDK stops on sent input with missing observation, preserves sent evidence and never resends", async (t) => {
  const vm = new CuaScriptController();
  t.after(() => vm.dispose());
  const calls = [];
  const output = await vm.execute(
    {
      code: "state.tab=cua.browser.use('owned'); await state.tab.getByLabel('Title').fill('draft'); await state.tab.getByText('Submit').click();"
    },
    async (name) => {
      calls.push(name);
      return result({
        dispatchStatus: "sent",
        requiresObservation: true,
        observationError: "capture_failed"
      });
    }
  );
  assert.equal(output.isError, true);
  assert.equal(output.details.errorCode, "observation_required");
  assert.equal(output.details.dispatchStatus, "sent");
  assert.deepEqual(calls, ["browser_act"]);
});

test(
  "real Chromium SDK composes scoped/nth/frame locators, cheap actions and fresh coordinate input",
  browserTestOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-sdk-browser-"));
    const fixture = await browserFixture();
    const browser = new BrowserUse({ taskDirectory: root });
    const vm = new CuaScriptController();
    t.after(async () => {
      await vm.dispose();
      await browser.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    });
    const calls = [];
    const dispatch = async (name, params, signal) => {
      calls.push({ name, params });
      return result(await browser.execute(name, params, signal));
    };
    const output = await vm.execute(
      {
        code: `
    state.tab=await cua.browser.open(${JSON.stringify(fixture.url)}+'advanced',{observation:'aria'});
    await state.tab.getByRole('region',{name:'Second'}).getByRole('button',{name:'Save'}).click({observation:'none'});
    await state.tab.getByRole('button',{name:'Save'}).nth(0).click({observation:'none'});
    const observed=await state.tab.observe({observation:'aria'});
    const frame=observed.frames.find(f=>f.name==='editor');
    const inFrame=await state.tab.frame(frame.frameId).getByRole('button',{name:'Save'}).click({observation:'aria'});
    await state.tab.observe({observation:'screenshot'});
    const clicked=await state.tab.clickAt(50,330,{observation:'aria'});
    return {frame:inFrame.observation.ariaSnapshot, canvas:clicked.observation.ariaSnapshot};
  `
      },
      dispatch
    );
    assert.equal(output.isError, undefined, JSON.stringify(output.details));
    assert.match(output.details.value.frame, /Frame saved/);
    assert.match(output.details.value.canvas, /Canvas clicked/);
    assert.equal(calls.filter((c) => c.params.observation === "none").length, 2);
    assert.ok(calls.at(-1).params.observationId);
  }
);

test(
  "VM reset and a fresh Tab cannot bypass the real browser feedback gate",
  browserTestOptions,
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "atria-sdk-browser-gate-"));
    const fixture = await browserFixture();
    const browser = new BrowserUse({ taskDirectory: root });
    const vm = new CuaScriptController();
    t.after(async () => {
      await vm.dispose();
      await browser.dispose();
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    });
    const dispatch = async (name, params, signal) => result(await browser.execute(name, params, signal));
    const { pageId } = await browser.execute("browser_open", { url: fixture.url });
    const missing = await vm.execute(
      {
        code: `state.tab=cua.browser.use(${JSON.stringify(pageId)}); await state.tab.getByRole('button',{name:'Remove body'}).click({timeoutMs:5000});`
      },
      dispatch
    );
    assert.equal(missing.isError, true);
    assert.equal(missing.details.errorCode, "observation_required");
    assert.equal(missing.details.dispatchStatus, "sent");
    assert.equal(missing.details.vmReset, true);
    const blocked = await vm.execute(
      {
        code: `state.tab=cua.browser.use(${JSON.stringify(pageId)}); await state.tab.goto(${JSON.stringify(fixture.url)},{observation:'none'});`
      },
      dispatch
    );
    assert.equal(blocked.details.errorCode, "observation_required");
    assert.equal(blocked.details.dispatchStatus, "not_sent");
    const recovered = await vm.execute(
      {
        code: `state.tab=cua.browser.use(${JSON.stringify(pageId)}); await state.tab.observe({observation:'screenshot'}); return await state.tab.goto(${JSON.stringify(fixture.url)},{observation:'aria'});`
      },
      dispatch
    );
    assert.equal(recovered.isError, undefined, JSON.stringify(recovered.details));
    assert.match(recovered.details.value.observation.ariaSnapshot, /Browser fixture|Save/);
  }
);
