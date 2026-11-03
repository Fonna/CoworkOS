import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { readJsonLines, streamRunEvents } from "../dist/src/dashboard/event-stream.js";

const line = (index) =>
  JSON.stringify({ eventId: `event-${index}`, type: "changed", payload: { index } }) + "\n";
async function waitFor(check) {
  const until = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < until, "the isolated stream must settle");
    await delay(10);
  }
}

test("an idle SSE ledger does not reread its history and an appended burst is delivered without dropping events", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "atria-ledger-performance-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = join(root, "task", "runs", "run");
  await fs.mkdir(directory, { recursive: true });
  const path = join(directory, "run_events.jsonl");
  await fs.writeFile(path, Array.from({ length: 650 }, (_, index) => line(index)).join(""));
  const request = new EventEmitter();
  const response = new EventEmitter();
  const records = [];
  response.writeHead = () => {};
  response.write = (chunk) => {
    const data = String(chunk)
      .split("\n")
      .find((part) => part.startsWith("data: "));
    if (data) records.push(JSON.parse(data.slice(6)));
    return true;
  };
  response.end = () => response.emit("close");
  t.after(() => request.emit("close"));
  streamRunEvents(request, response, "task", "run", root);
  await waitFor(() => records.length === 500);
  assert.equal(records[0].eventId, "event-150", "initial replay keeps its existing 500-event tail");

  const originalRead = fs.readFile;
  const originalOpen = fs.open;
  let bodyReads = 0;
  fs.readFile = async (file, ...args) => {
    if (String(file) === path) bodyReads++;
    return originalRead(file, ...args);
  };
  fs.open = async (file, ...args) => {
    if (String(file) === path) bodyReads++;
    return originalOpen(file, ...args);
  };
  syncBuiltinESMExports();
  try {
    await delay(700);
    assert.equal(bodyReads, 0, "unchanged history only needs a metadata check");
    await fs.appendFile(path, Array.from({ length: 600 }, (_, index) => line(index + 650)).join(""));
    await waitFor(() => records.length === 1100);
    assert.deepEqual(
      records.slice(500).map((record) => record.eventId),
      Array.from({ length: 600 }, (_, index) => `event-${index + 650}`)
    );
    assert.equal(bodyReads, 1, "the new range is read once");
    const replacement = `${path}.replacement`;
    await fs.writeFile(replacement, line(1300) + line(1301));
    await fs.rename(replacement, path);
    await waitFor(() => records.length === 1102);
    assert.deepEqual(
      records.slice(-2).map((record) => record.eventId),
      ["event-1300", "event-1301"]
    );
  } finally {
    fs.readFile = originalRead;
    fs.open = originalOpen;
    syncBuiltinESMExports();
    request.emit("close");
  }
});

test("a detail's recent ledger tail reads a bounded range and retains UTF-8 and an unterminated last record", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "atria-ledger-tail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const path = join(root, "events.jsonl");
  const records = Array.from({ length: 10000 }, (_, index) => ({ index, text: "中文😀".repeat(30) }));
  await fs.writeFile(path, records.map((record) => JSON.stringify(record)).join("\r\n"));
  const originalRead = fs.readFile;
  const originalOpen = fs.open;
  let bytes = 0;
  fs.readFile = async (file, ...args) => {
    const result = await originalRead(file, ...args);
    if (String(file) === path) bytes += Buffer.byteLength(result);
    return result;
  };
  fs.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (String(file) === path) {
      const read = handle.read.bind(handle);
      handle.read = async (...args) => {
        const result = await read(...args);
        bytes += result.bytesRead;
        return result;
      };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await readJsonLines(path, 30), records.slice(-30));
    assert.ok(bytes <= 65536, `a short tail must not read the whole ${bytes}-byte history`);
  } finally {
    fs.readFile = originalRead;
    fs.open = originalOpen;
    syncBuiltinESMExports();
  }
});
