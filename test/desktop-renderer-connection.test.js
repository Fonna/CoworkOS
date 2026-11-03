import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const { connectRenderer } = createRequire(import.meta.url)("../desktop/renderer-connection.cjs");
const backend = { url: "http://127.0.0.1:12345", token: "synthetic-session-token" };

test("renderer navigation waits for its authenticated session cookie", async () => {
  const events = [];
  await connectRenderer(
    backend,
    {
      set: async (cookie) => {
        assert.equal(cookie.httpOnly, true);
        assert.equal(cookie.value, backend.token);
        events.push("cookie");
      }
    },
    () => ({
      isDestroyed: () => false,
      loadURL: async (url) => {
        assert.equal(url, backend.url);
        events.push("navigate");
      }
    })
  );
  assert.deepEqual(events, ["cookie", "navigate"]);
});

test("closing the window during a model restart still updates authentication for the next window", async () => {
  let window = {
    isDestroyed: () => false,
    loadURL: async () => {
      assert.fail("a closed window must not be loaded");
    }
  };
  let installed;
  await connectRenderer(
    backend,
    {
      set: async (cookie) => {
        installed = cookie;
        window = undefined;
      }
    },
    () => window
  );
  assert.equal(installed.value, backend.token);
  await connectRenderer(backend, { set: async () => {} }, () => ({
    isDestroyed: () => true,
    loadURL: () => assert.fail("destroyed window")
  }));
});

test("a cookie installation failure cannot navigate into an unauthenticated session", async () => {
  await assert.rejects(
    connectRenderer(
      backend,
      {
        set: async () => {
          throw new Error("synthetic cookie failure");
        }
      },
      () => ({
        isDestroyed: () => false,
        loadURL: () => assert.fail("cookie must be ready before navigation")
      })
    ),
    /cookie failure/
  );
});
