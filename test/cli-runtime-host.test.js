import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCliProcess } from "../scripts/cli-runtime-host.mjs";

test("the headless shell bootstrap does not add flags to worker inheritance", async (t) => {
  const f = await fixture(
    t,
    "import {Worker} from 'node:worker_threads';import {writeFileSync} from 'node:fs';" +
      "const worker=new Worker(\"require('node:worker_threads').parentPort.postMessage(process.execArgv)\",{eval:true});" +
      "worker.once('message',args=>writeFileSync('worker-args.json',JSON.stringify(args)));"
  );
  const bootstrap = new URL("../scripts/cli-shell-boot.mjs", import.meta.url);
  assert.equal(await runCliProcess({ ...f, bootstrap: bootstrap.pathname }), 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.projectDirectory, "worker-args.json"), "utf8")), []);
});

async function fixture(t, source) {
  const root = await mkdtemp(join(tmpdir(), "atria-cli-host-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "child.mjs");
  await writeFile(executable, source);
  return { executable, projectDirectory: root, args: [], env: {} };
}

test("SDK readiness requires the current token, is consumed once and does not leak signal handlers", async (t) => {
  const f = await fixture(
    t,
    `
process.send({type:"atria.cli.uiReady",token:"wrong"});
process.send({type:"other",token:process.env.ATRIA_CLI_UI_READY_TOKEN});
process.send({type:"atria.cli.uiReady",token:process.env.ATRIA_CLI_UI_READY_TOKEN});
process.send({type:"atria.cli.uiReady",token:process.env.ATRIA_CLI_UI_READY_TOKEN},()=>process.exit(7));
`
  );
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  let acknowledgements = 0;
  const code = await runCliProcess({ ...f, uiCompatibility: true, onSdkReady: () => acknowledgements++ });
  assert.equal(code, 7);
  assert.equal(acknowledgements, 1);
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], before);
});

test("a failed or ordinary child cannot acknowledge UI readiness and retains its exit status", async (t) => {
  const f = await fixture(t, "process.exit(process.env.ATRIA_CLI_UI_READY_TOKEN ? 2 : 3);");
  let acknowledgements = 0;
  for (const [uiCompatibility, expected] of [
    [true, 2],
    [false, 3]
  ]) {
    assert.equal(
      await runCliProcess({ ...f, uiCompatibility, onSdkReady: () => acknowledgements++ }),
      expected
    );
  }
  assert.equal(acknowledgements, 0);
});
