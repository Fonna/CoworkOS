import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CuaScriptController, CUA_SCRIPT_LIMITS } from "../dist/src/tools/cua-script.js";
import { ComputerUse } from "../dist/src/gui/computer-use.js";

const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const imageRef = "img_11111111-1111-4111-8111-111111111111";
const result = (details, images = []) => ({
  content: [{ type: "text", text: JSON.stringify(details) }, ...images],
  details
});
const unavailable = async () => {
  throw new Error("unexpected host call");
};
function controller(t) {
  const value = new CuaScriptController();
  t.after(() => value.dispose());
  return value;
}

test("QuickJS state persists explicit variables and real SDK objects; local declarations do not", async (t) => {
  const vm = controller(t),
    calls = [];
  const dispatch = async (name, params) => {
    calls.push({ name, params });
    if (name === "browser_open") return result({ pageId: "page-1", imageRef });
    if (name === "browser_act")
      return result({
        dispatchStatus: "sent",
        effectVerified: false,
        observation: { pageId: "page-1", url: "https://fixture.invalid/next" }
      });
    return result({ status: "condition_met", observation: { pageId: "page-1" } });
  };
  const first = await vm.execute(
    {
      code: "let local=4; state.n=local; state.tab=await cua.browser.open('https://fixture.invalid'); console.log('opened',state.tab.pageId); return state.tab.pageId;"
    },
    dispatch
  );
  assert.equal(first.isError, undefined);
  assert.equal(first.details.value, "page-1");
  assert.deepEqual(first.details.logs, ['["opened","page-1"]']);
  const second = await vm.execute(
    {
      code: "state.n++; await state.tab.getByRole('button',{name:'Export'}).click({expectDownload:true}); await state.tab.goto('https://fixture.invalid/next'); return {n:state.n,local:typeof local,pageId:state.tab.pageId};"
    },
    dispatch
  );
  assert.deepEqual(second.details.value, { n: 5, local: "undefined", pageId: "page-1" });
  assert.deepEqual(calls[1].params, {
    pageId: "page-1",
    action: { type: "click", target: { kind: "role", role: "button", name: "Export" }, expectDownload: true }
  });
  assert.deepEqual(calls[2].params.action, { type: "navigate", url: "https://fixture.invalid/next" });
  await vm.reset();
  assert.equal(
    (await vm.execute({ code: "return typeof state.tab;" }, unavailable)).details.value,
    "undefined"
  );
});

test("Window SDK executes continuous actions with successive real ComputerUse credentials", async (t) => {
  const vm = controller(t),
    effects = [],
    credentials = [];
  const target = {
    pid: 1,
    windowId: 2,
    application: "Fixture",
    title: "Local",
    bundleId: "org.atria.fixture"
  };
  const computer = new ComputerUse({
    status: async () => ({ available: true, screenRecording: true, accessibility: true, windows: [target] }),
    observe: async () => ({
      width: 1,
      height: 1,
      image,
      frame: { x: 0, y: 0, width: 1, height: 1 },
      accessibilityText: "Ready"
    }),
    act: async (_target, action) => effects.push(action)
  });
  computer.configurePolicy({ enabled: true, mode: "control" });
  const dispatch = async (name, params, signal) => {
    if (name === "computer_select")
      return result({
        session: await computer.select("script", params.pid, params.windowId, params.mode, signal)
      });
    if (name === "computer_observe")
      return result(await computer.observe("script", params.sessionId, signal));
    if (name === "computer_wait")
      return result(
        await computer.wait("script", params.sessionId, params.condition, params.timeoutMs, signal)
      );
    if (name === "computer_act") {
      credentials.push(params.observationId);
      return result(
        await computer.act("script", params.sessionId, params.observationId, params.action, signal, true)
      );
    }
    throw new Error(name);
  };
  const first = await vm.execute(
    {
      code: "state.win=await cua.computer.select({pid:1,windowId:2,mode:'control'}); await state.win.act({type:'activate'}); await state.win.act({type:'type',text:'fixture input'}); return state.win.observation.observationId;"
    },
    dispatch
  );
  assert.equal(first.isError, undefined, JSON.stringify(first.details));
  const second = await vm.execute(
    {
      code: "await state.win.wait({type:'accessibility_text',text:'Ready',state:'present'},{timeoutMs:100}); await state.win.act({type:'key',keys:['Enter']}); return state.win.sessionId;"
    },
    dispatch
  );
  assert.equal(second.isError, undefined, JSON.stringify(second.details));
  assert.equal(new Set(credentials).size, 3);
  assert.deepEqual(
    effects.map((action) => action.type),
    ["activate", "type", "key"]
  );
  assert.equal(first.details.dispatchStatus, "sent");
  assert.ok(first.details.calls.every((call) => !JSON.stringify(call).includes("fixture input")));
});

test("Tab maps label/text/testId operations with current observations", async (t) => {
  const vm = controller(t),
    calls = [];
  const dispatch = async (name, params) => {
    calls.push({ name, params });
    return result(
      name === "browser_act"
        ? { dispatchStatus: "sent", observation: { pageId: "page-2" } }
        : { status: "condition_met", observation: { pageId: "page-2" } }
    );
  };
  const output = await vm.execute(
    {
      code: "state.tab=cua.browser.use('page-2'); await state.tab.getByLabel('Title').fill('Private value'); await state.tab.getByText('Save').press('Enter'); await state.tab.getByTestId('format').select('PDF'); await state.tab.getByRole('button',{name:'Done'}).waitFor({state:'enabled',timeoutMs:25}); await state.tab.act({type:'navigate',url:'https://fixture.invalid'}); return state.tab.observation;"
    },
    dispatch
  );
  assert.deepEqual(output.details.value, { pageId: "page-2" });
  assert.equal(calls[0].params.action.type, "fill");
  assert.equal(calls[1].params.action.type, "press");
  assert.equal(calls[2].params.action.type, "select");
  assert.deepEqual(calls[3].params, {
    pageId: "page-2",
    condition: { type: "element", target: { kind: "role", role: "button", name: "Done" }, state: "enabled" },
    timeoutMs: 25
  });
  assert.equal(JSON.stringify(output.details.calls).includes("Private value"), false);
});

for (const dispatchStatus of ["sent", "unknown", "not_sent"])
  test(`CUA tool errors retain ${dispatchStatus} metadata, can be caught, and never retry`, async (t) => {
    const vm = controller(t);
    let attempts = 0;
    const dispatch = async () => {
      attempts++;
      return {
        ...result({
          error: "capture failed",
          errorCode: "driver_failed",
          dispatchStatus,
          requiresObservation: dispatchStatus !== "not_sent"
        }),
        isError: true
      };
    };
    const output = await vm.execute(
      { code: "state.tab=cua.browser.use('page'); await state.tab.getByText('Send').click();" },
      dispatch
    );
    assert.equal(output.isError, true);
    assert.equal(output.details.errorCode, "driver_failed");
    assert.equal(output.details.dispatchStatus, dispatchStatus);
    assert.equal(output.details.requiresObservation, dispatchStatus !== "not_sent");
    assert.equal(output.details.vmReset, true);
    assert.equal(attempts, 1);
    const caught = await vm.execute(
      {
        code: "state.tab=cua.browser.use('page'); try {await state.tab.getByText('Send').click();} catch(e) {return {errorCode:e.errorCode,dispatchStatus:e.dispatchStatus,observation:state.tab.observation};}"
      },
      dispatch
    );
    assert.deepEqual(caught.details.value, { errorCode: "driver_failed", dispatchStatus, observation: null });
    assert.equal(caught.details.vmReset, false);
    assert.equal(attempts, 2);
  });

test("post-dispatch oversized image/metadata errors preserve known sent certainty", async (t) => {
  const vm = controller(t);
  for (const kind of ["image", "metadata"]) {
    let attempts = 0;
    const output = await vm.execute(
      { code: "await cua.browser.use('page').getByText('Send').click();" },
      async () => {
        attempts++;
        return result(
          {
            dispatchStatus: "sent",
            ...(kind === "metadata" ? { text: "x".repeat(CUA_SCRIPT_LIMITS.metadataBytes) } : {})
          },
          kind === "image"
            ? [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: Buffer.alloc(CUA_SCRIPT_LIMITS.imageBytes + 1).toString("base64")
                }
              ]
            : []
        );
      }
    );
    assert.equal(output.details.errorCode, "output_limit");
    assert.equal(output.details.dispatchStatus, "sent");
    assert.equal(output.details.calls[0].dispatchStatus, "sent");
    assert.equal(output.details.requiresObservation, true);
    assert.equal(attempts, 1);
  }
});

test("known sent metadata survives cancellation in the dispatcher completion microtask", async (t) => {
  const vm = controller(t),
    abort = new AbortController();
  const output = await vm.execute(
    { code: "await cua.browser.use('page').getByText('Send').click();" },
    async () => {
      abort.abort();
      return result({ dispatchStatus: "sent", requiresObservation: true });
    },
    abort.signal
  );
  assert.equal(output.details.dispatchStatus, "sent");
  assert.equal(output.details.requiresObservation, true);
  assert.equal(output.details.vmReset, true);
});

test("deep guest exceptions cannot destroy structured error output or completed action evidence", async (t) => {
  const vm = controller(t);
  for (const code of [
    "let x={};for(let i=0;i<30;i++)x={x};throw x;",
    "let x={};for(let i=0;i<30;i++)x={x};const e=new Error('deep');e.payload=x;throw e;",
    "const x={};x.cycle=x;throw x;"
  ]) {
    const output = await vm.execute(
      { code: `await cua.browser.open('https://fixture.invalid');${code}` },
      async () => result({ pageId: "page", dispatchStatus: "sent" })
    );
    assert.equal(output.isError, true);
    assert.equal(output.details.vmReset, true);
    assert.equal(output.details.dispatchStatus, "sent");
    assert.equal(output.details.requiresObservation, true);
    assert.equal(output.details.calls[0].dispatchStatus, "sent");
    assert.ok(Buffer.byteLength(output.content[0].text) <= CUA_SCRIPT_LIMITS.outputBytes);
  }
});

test("recursive stacks and 5000-level results/errors fail safely in an independent Node process", async () => {
  const moduleUrl = new URL("../dist/src/tools/cua-script.js", import.meta.url).href;
  const program = `
    import assert from 'node:assert/strict';
    import {CuaScriptController} from ${JSON.stringify(moduleUrl)};
    const vm=new CuaScriptController();
    const cases=[
      "let x={};for(let i=0;i<5000;i++)x={x};return x;",
      "let x={};for(let i=0;i<5000;i++)x={x};throw x;",
      "function recur(){return recur()};recur();",
      "throw {get message(){while(true){}}};",
      "let x={};for(let i=0;i<5000;i++)x={x};Object.prototype.toJSON=()=>{throw x};throw Error('polluted');"
    ];
    for(const code of cases){
      let calls=0;
      const output=await vm.execute({code:"await cua.browser.open('https://fixture.invalid');"+code},async()=>{calls++;return{content:[],details:{pageId:'page',dispatchStatus:'sent'}}});
      assert.equal(output.isError,true);
      assert.equal(output.details.dispatchStatus,'sent');
      assert.equal(output.details.requiresObservation,true);
      assert.equal(output.details.vmReset,true);
      assert.equal(calls,1);
      assert.equal((await vm.execute({code:'return Object.keys(state);'},async()=>{throw Error('unexpected')})).details.value.length,0);
    }
    await vm.dispose();
    console.log('SAFE_STACK_AND_RESULT_ERRORS');
  `;
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", program],
    { timeout: 5000, maxBuffer: 1024 * 1024 }
  );
  assert.match(stdout, /SAFE_STACK_AND_RESULT_ERRORS/);
  assert.equal(stderr, "", "no WASM assertion or leaked runtime is acceptable");
});

for (const mode of ["cancel", "timeout", "reset"])
  test(`${mode} aborts pending RPC and prevents its late completion from sending the next action`, async (t) => {
    const vm = controller(t),
      abort = new AbortController();
    let begun,
      finish,
      calls = 0,
      innerSignal;
    const started = new Promise((resolve) => {
      begun = resolve;
    });
    const held = new Promise((resolve) => {
      finish = resolve;
    });
    const dispatch = async (_name, _params, signal) => {
      calls++;
      innerSignal = signal;
      begun();
      await held;
      return result({ dispatchStatus: "sent", observation: { pageId: "page" } });
    };
    const work = vm.execute(
      {
        code: "state.tab=cua.browser.use('page'); await state.tab.getByText('One').click(); await state.tab.getByText('Two').click();",
        timeoutMs: mode === "timeout" ? 30 : 1000
      },
      dispatch,
      abort.signal
    );
    await started;
    if (mode === "cancel") abort.abort();
    if (mode === "reset") await vm.reset();
    const output = await work;
    assert.equal(output.details.vmReset, true);
    assert.equal(output.details.dispatchStatus, "unknown");
    assert.equal(innerSignal.aborted, true);
    finish();
    await delay(20);
    assert.equal(calls, 1);
    assert.equal(
      (await vm.execute({ code: "return typeof state.tab;" }, unavailable)).details.value,
      "undefined"
    );
  });

test("unawaited RPCs are cancelled before queued effects and do not survive the cell", async (t) => {
  const vm = controller(t);
  let calls = 0;
  const output = await vm.execute(
    {
      code: "cua.browser.use('page').getByText('One').click(); cua.browser.use('page').getByText('Two').click(); return 'done';"
    },
    async (_name, _params, signal) => {
      calls++;
      await delay(20);
      signal.throwIfAborted();
      return result({ dispatchStatus: "sent" });
    }
  );
  assert.equal(output.details.errorCode, "unawaited_host_call");
  assert.equal(output.details.vmReset, true);
  await delay(50);
  assert.ok(calls <= 1);
  assert.ok(output.details.calls.every((call) => call.status === "error"));
});

test("reset invalidates already queued cells before they can send input", async (t) => {
  const vm = controller(t);
  let calls = 0;
  const held = vm.execute({ code: "state.old=true;await new Promise(()=>{});" }, unavailable);
  await delay(5);
  const queued = vm.execute(
    { code: "await cua.browser.use('page').getByText('Send').click();" },
    async () => {
      calls++;
      return result({ dispatchStatus: "sent" });
    }
  );
  await vm.reset();
  assert.equal((await held).details.errorCode, "session_reset");
  assert.equal((await queued).details.errorCode, "session_reset");
  assert.equal(calls, 0);
  assert.equal(
    (await vm.execute({ code: "return typeof state.old;" }, unavailable)).details.value,
    "undefined"
  );
});

test("synchronous computation has a 50ms ceiling and recursive Promise jobs leave the host cancellable", async (t) => {
  const vm = controller(t);
  const before = performance.now();
  const loop = await vm.execute({ code: "while(true) {}", timeoutMs: 2000 }, unavailable);
  assert.equal(loop.details.errorCode, "cpu_budget_exceeded");
  assert.ok(performance.now() - before < 500, "loop must not block the host for the whole cell timeout");
  let heartbeat = 0;
  const timer = setInterval(() => heartbeat++, 5),
    abort = new AbortController();
  t.after(() => clearInterval(timer));
  setTimeout(() => abort.abort(), 30);
  const recursive = await vm.execute(
    {
      code: "async function recur(){await Promise.resolve();return recur();} await recur();",
      timeoutMs: 2000
    },
    unavailable,
    abort.signal
  );
  assert.equal(recursive.details.errorCode, "cancelled");
  assert.ok(heartbeat >= 1, "main-loop timers must run during guest Promise recursion");
  assert.equal(recursive.details.vmReset, true);
});

test("a pending pure Promise observes the deadline without spinning the host event loop", async (t) => {
  const vm = controller(t);
  const output = await vm.execute({ code: "await new Promise(()=>{});", timeoutMs: 25 }, unavailable);
  assert.equal(output.details.errorCode, "script_timeout");
});

test("code, RPC, output and memory limits reset the VM and permit a fresh cell", async (t) => {
  const vm = controller(t);
  const cases = [
    { code: " ".repeat(CUA_SCRIPT_LIMITS.codeBytes + 1), expected: "input_limit" },
    { code: "for(let i=0;i<65;i++) await cua.computer.status();", expected: "host_call_limit" },
    { code: "console.log('x'.repeat(140000));", expected: "output_limit" },
    { code: "state.large=new Uint8Array(80*1024*1024);", expected: "memory_limit" }
  ];
  for (const input of cases) {
    const output = await vm.execute(input, async () => result({ available: true }));
    assert.equal(output.details.errorCode, input.expected, JSON.stringify(output.details));
    assert.equal(output.details.vmReset, true);
    assert.equal(
      (await vm.execute({ code: "return Object.keys(state);" }, unavailable)).details.value.length,
      0
    );
  }
});

test("only bounded image blocks and imageRefs cross the guest boundary", async (t) => {
  const vm = controller(t),
    names = [];
  const output = await vm.execute(
    {
      code: "for(let i=0;i<5;i++) state.observation=await cua.computer.use('session').observe(); await cua.emitImage(state.observation.imageRef); return state.observation;"
    },
    async (name, params) => {
      names.push(name);
      if (name === "read_image") assert.deepEqual(params, { imageRef });
      return result({ imageRef, observationId: "obs", image, nested: { data: image } }, [
        { type: "image", mimeType: "image/png", data: image }
      ]);
    }
  );
  assert.equal(output.isError, undefined);
  assert.equal(output.content.filter((block) => block.type === "image").length, 4);
  assert.deepEqual(output.details.visualFeedback, { delivered: 4, superseded: 2 });
  assert.equal(JSON.stringify(output.details).includes(image), false);
  assert.equal(names.at(-1), "read_image");
  const invalid = await vm.execute({ code: "await cua.emitImage('/private/file.png');" }, unavailable);
  assert.equal(invalid.details.errorCode, "invalid_argument");
});

test("the isolated guest has no Node, filesystem, network or arbitrary module bridge", async (t) => {
  const vm = controller(t);
  const output = await vm.execute(
    {
      code: "return {process:typeof process,require:typeof require,fetch:typeof fetch,rpc:typeof __cuaRpc,fs:typeof fs};"
    },
    unavailable
  );
  assert.deepEqual(output.details.value, {
    process: "undefined",
    require: "undefined",
    fetch: "undefined",
    rpc: "undefined",
    fs: "undefined"
  });
  const imported = await vm.execute({ code: "await import('node:fs');" }, unavailable);
  assert.equal(imported.isError, true);
  await vm.dispose();
  assert.equal((await vm.execute({ code: "return 1;" }, unavailable)).details.errorCode, "session_reset");
});
