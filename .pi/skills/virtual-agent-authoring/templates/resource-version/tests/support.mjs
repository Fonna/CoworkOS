import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each package carries this helper so its tests still run after relocation.
export async function fixture(t, source) {
  const directory = await mkdtemp(join(tmpdir(), "atria-watcher-template-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = join(directory, "input.json");
  const statePath = join(directory, "state.json");
  let response = { status: 200, content: JSON.stringify({ items: [] }) };
  let failure;
  const readState = async () => {
    try {
      return JSON.parse(await readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
  };
  return {
    directory,
    input,
    statePath,
    readState,
    write: (data) => writeFile(input, typeof data === "string" ? data : JSON.stringify(data)),
    response(data, status = 200) {
      response = { status, content: typeof data === "string" ? data : JSON.stringify(data) };
      failure = undefined;
    },
    fail(error = new Error("source unavailable")) {
      failure = error;
    },
    async poll(check) {
      const before = await readState();
      let result;
      try {
        result = await check({
          watcherId: "fixture",
          task: "test",
          sources: [source ?? input],
          previousState: structuredClone(before),
          readState,
          fetchUrl: async () => {
            if (failure) throw failure;
            return structuredClone(response);
          }
        });
      } catch (error) {
        assert.deepEqual(await readState(), before, "a failed check must not advance durable state");
        throw error;
      }
      assert.ok(Array.isArray(result.events));
      for (const event of result.events) {
        assert.equal(typeof event.source, "string");
        assert.equal(typeof event.type, "string");
        assert.ok(event.dedupeKey && event.dedupeKey.length <= 512);
        assert.ok(Buffer.byteLength(JSON.stringify(event.payload)) <= 8_192, "evidence is bounded");
      }
      await writeFile(statePath, JSON.stringify(result.state));
      return result.events;
    }
  };
}
