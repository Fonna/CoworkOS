import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const templates = join(root, ".pi/skills/virtual-agent-authoring/templates");
const validator = join(root, ".pi/skills/virtual-agent-authoring/scripts/validate_package.mjs");
const slugs = [
  "job-lifecycle",
  "metric-threshold",
  "resource-version",
  "feed-keyword",
  "entity-state",
  "timer"
];

for (const slug of slugs) {
  const sourceDirectory = join(templates, slug);
  test(`${slug} remains valid and passes its behavioral tests outside the repository`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "atria-portable-template-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await cp(sourceDirectory, directory, { recursive: true });
    const validation = spawnSync(process.execPath, [validator, directory], {
      encoding: "utf8",
      timeout: 5_000
    });
    assert.equal(validation.status, 0, validation.stderr || validation.error?.message);
    const env = { ...process.env };
    // A nested Node runner otherwise inherits the parent's binary IPC reporter.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ["--test", "tests/rule.test.mjs"], {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 15_000
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /fail 0/);
    assert.doesNotMatch(result.stdout, /skipped [1-9]/);
    assert.equal((await readFile(join(directory, "manifest.json"), "utf8")).includes("apiKey"), false);
  });
}

test("the actual ScriptWatcher persists a copied standalone rule across fresh worker processes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "atria-template-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "watcher"));
  const source = join(directory, "metrics.json");
  const original = await readFile(join(templates, "metric-threshold/watcher/rule.mjs"), "utf8");
  // Registration copies only the rule. No helper, manifest or sidecar config is installed.
  await writeFile(
    join(directory, "watcher/rule.mjs"),
    original.replace(
      "export default createWatcher(CONFIG);",
      'export default createWatcher({ ...CONFIG, metric: "loss", unit: "ratio", threshold: 10, consecutiveSamples: 1 });'
    )
  );
  const scriptWatcher = new URL("../dist/src/runtime/script-watcher.js", import.meta.url).href;
  const code = `import { ScriptWatcher } from ${JSON.stringify(scriptWatcher)};
const watcher = new ScriptWatcher({watcherId:"fixture",workDirectory:${JSON.stringify(directory)},
monitor:{task:"check training",sourcesHint:[${JSON.stringify(source)}]}});
const events = await watcher.poll();
await watcher.acknowledge(events);
console.log(JSON.stringify(events));`;
  const poll = () => {
    // Node >=22.19 can strip this runtime module's types without installing the product stack.
    const child = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", code],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000
      }
    );
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    return JSON.parse(child.stdout.trim());
  };
  await writeFile(
    source,
    JSON.stringify({ metric: "loss", unit: "ratio", value: 1, observedAt: new Date().toISOString() })
  );
  assert.deepEqual(poll(), []);
  await writeFile(
    source,
    JSON.stringify({ metric: "loss", unit: "ratio", value: 11, observedAt: new Date().toISOString() })
  );
  const [event] = poll();
  assert.equal(event.type, "metric.threshold");
  assert.equal(event.watcherId, "fixture");
  assert.equal(JSON.parse(await readFile(join(directory, "watcher/state.json"), "utf8")).latched, true);
  assert.deepEqual(poll(), [], "a fresh worker reads the durable cursor and cannot repeat the alert");
});

test("training combines job, metric and artifact probes without repeating settled evidence", async (t) => {
  const { fixture } = await import(
    new URL(
      "../.pi/skills/virtual-agent-authoring/templates/job-lifecycle/tests/support.mjs",
      import.meta.url
    )
  );
  const { createWatcher: job } = await import(
    new URL("../.pi/skills/virtual-agent-authoring/templates/job-lifecycle/watcher/rule.mjs", import.meta.url)
  );
  const { createWatcher: metric } = await import(
    new URL(
      "../.pi/skills/virtual-agent-authoring/templates/metric-threshold/watcher/rule.mjs",
      import.meta.url
    )
  );
  const { createWatcher: artifact } = await import(
    new URL(
      "../.pi/skills/virtual-agent-authoring/templates/resource-version/watcher/rule.mjs",
      import.meta.url
    )
  );
  const jobs = await fixture(t);
  const metrics = await fixture(t);
  const artifacts = await fixture(t);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  });
  let clock = Date.now() + 100;
  const logPath = join(jobs.directory, "training.log");
  await writeFile(logPath, "step 1\n");
  const record = {
    jobId: "train-1",
    command: "train",
    cwd: jobs.directory,
    pid: child.pid,
    logPath,
    startedAt: new Date(clock - 1_000).toISOString()
  };
  await jobs.write(record);
  const jobRule = job({ now: () => clock });
  const metricConfig = {
    metric: "loss",
    unit: "ratio",
    threshold: 10,
    consecutiveSamples: 2,
    now: () => clock
  };
  const sample = (value) =>
    metrics.write({ metric: "loss", unit: "ratio", value, observedAt: new Date(clock).toISOString() });
  await sample(1);
  assert.deepEqual(await jobs.poll(jobRule), []);
  assert.deepEqual(await metrics.poll(metric(metricConfig)), []);
  assert.deepEqual(await artifacts.poll(artifact()), []);
  const events = [];
  for (const value of [11, 12]) {
    clock += 1_000;
    await sample(value);
    events.push(...(await metrics.poll(metric(metricConfig))));
  }
  await artifacts.write("evaluation complete");
  assert.deepEqual(await artifacts.poll(artifact()), []);
  events.push(...(await artifacts.poll(artifact())));
  child.kill();
  await once(child, "exit");
  await jobs.write({ ...record, finishedAt: new Date(clock).toISOString(), exitCode: 0 });
  events.push(...(await jobs.poll(jobRule)));
  assert.deepEqual(
    events.map((event) => event.type),
    ["metric.threshold", "resource.created", "job.finished"]
  );
  assert.deepEqual(await jobs.poll(job({ now: () => clock })), []);
  assert.deepEqual(await metrics.poll(metric(metricConfig)), []);
  assert.deepEqual(await artifacts.poll(artifact()), []);
});

test("background news filters repeated and unrelated content and keeps a separate periodic review", async (t) => {
  const { fixture } = await import(
    new URL("../.pi/skills/virtual-agent-authoring/templates/feed-keyword/tests/support.mjs", import.meta.url)
  );
  const { createWatcher: feed } = await import(
    new URL("../.pi/skills/virtual-agent-authoring/templates/feed-keyword/watcher/rule.mjs", import.meta.url)
  );
  const { createWatcher: timer } = await import(
    new URL("../.pi/skills/virtual-agent-authoring/templates/timer/watcher/rule.mjs", import.meta.url)
  );
  const news = await fixture(t, "https://example.test/news.json");
  const review = await fixture(t, "clock");
  let clock = Date.parse("2026-10-10T00:00:00Z");
  const feedConfig = { keywords: ["coworkos"] };
  const timerConfig = {
    startAt: new Date(clock + 360_000).toISOString(),
    intervalMs: 360_000,
    now: () => clock
  };
  await news.poll(feed(feedConfig));
  await review.poll(timer(timerConfig));
  const events = [];
  for (let i = 1; i <= 6; i++) {
    clock += 60_000;
    news.response({
      items: [
        { id: "weather", title: "Weather" },
        ...(i < 3 ? [] : [{ id: "release", title: "CoworkOS release" }])
      ]
    });
    events.push(...(await news.poll(feed(feedConfig))), ...(await review.poll(timer(timerConfig))));
  }
  assert.deepEqual(
    events.map((event) => event.type),
    ["feed.new", "timer.due"]
  );
  assert.equal(events[0].payload.id, "release");
  assert.deepEqual(await news.poll(feed(feedConfig)), []);
  assert.deepEqual(await review.poll(timer(timerConfig)), []);
});
