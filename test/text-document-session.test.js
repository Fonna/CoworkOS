import assert from "node:assert/strict";
import { test } from "node:test";
import { TextDocumentSession } from "../web/assets/workbench/adapters/text-document-session.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(content = "原文\n") {
  const server = { content, revision: 0 };
  const requests = [];
  const read = () => ({
    resource: {
      resourceId: "res_1",
      appType: "text-editor",
      kind: "text/plain",
      title: "doc.txt",
      revision: server.revision
    },
    snapshot: { content: server.content }
  });
  const transport = {
    async read() {
      return read();
    },
    async write(operation) {
      requests.push(operation);
      if (operation.baseRevision !== server.revision)
        throw Object.assign(new Error("stale"), { code: "revision_conflict" });
      const { from, to, text } = operation.payload;
      server.content = server.content.slice(0, from) + text + server.content.slice(to);
      server.revision += 1;
      return { ...read(), event: { eventId: `event-${server.revision}`, revision: server.revision } };
    },
    async undo() {
      server.content = content;
      server.revision += 1;
      return { ...read(), event: { eventId: `event-${server.revision}`, revision: server.revision } };
    }
  };
  const session = new TextDocumentSession({ transport });
  return { session, transport, server, requests, read };
}

test("initial reads, clearing and undo advance the baseline without inventing a draft", async () => {
  const { session, server } = fixture();
  assert.equal(session.phase, "loading");
  await session.load();
  assert.equal(session.phase, "clean");
  assert.equal(session.state.draftContent, "原文\n");
  session.edit("");
  assert.equal(session.phase, "dirty");
  await session.save();
  assert.equal(server.content, "");
  assert.equal(session.phase, "clean");
  await session.undo();
  assert.equal(session.state.draftContent, "原文\n");
  assert.equal(session.dirty, false);
});

test("save callers share one drain and preserve typing arriving during a pending write", async () => {
  const { session, transport, server, requests } = fixture();
  await session.load();
  const gate = deferred();
  const write = transport.write;
  transport.write = async (operation) => {
    if (!requests.length) await gate.promise;
    return write(operation);
  };
  session.edit("第一段\n");
  const saving = session.save();
  const operation = session.pendingOperation();
  assert.equal(session.phase, "saving");
  session.edit("第一段\n保存期间继续输入 😀\n");
  assert.equal(session.save(), saving);
  assert.equal(
    session.pendingOperation().operationId,
    operation.operationId,
    "unload reuses the in-flight idempotency key"
  );
  gate.resolve();
  assert.equal(await saving, true);
  assert.equal(requests.length, 2);
  assert.equal(server.content, "第一段\n保存期间继续输入 😀\n");
  assert.equal(session.phase, "clean");
});

test("a newer remote read wins over an older save response while retaining the local draft", async () => {
  const { session, transport, server, read } = fixture();
  await session.load();
  const response = deferred();
  transport.write = () => response.promise;
  session.edit("本地改动\n");
  const saving = session.save();
  server.content = "其他协作者更新\n";
  server.revision = 2;
  await session.load();
  response.resolve({
    resource: { ...read().resource, revision: 1 },
    snapshot: { content: "本地改动\n" },
    event: { eventId: "event-1", revision: 1 }
  });
  assert.equal(await saving, false);
  assert.equal(session.state.serverRevision, 2);
  assert.equal(session.state.serverContent, "其他协作者更新\n");
  assert.equal(session.state.draftContent, "本地改动\n");
  assert.equal(session.phase, "conflict");
});

test("reading our in-flight revision does not turn subsequent typing into a remote conflict", async () => {
  const { session, transport, server, requests, read } = fixture();
  await session.load();
  const response = deferred();
  const write = transport.write;
  transport.write = (operation) => {
    if (!requests.length) {
      requests.push(operation);
      return response.promise;
    }
    return write(operation);
  };
  session.edit("第一段\n");
  const saving = session.save();
  session.edit("第一段\n后续输入\n");
  server.content = "第一段\n";
  server.revision = 1;
  await session.load();
  assert.equal(session.state.conflict, null);
  response.resolve({ ...read(), event: { eventId: "event-1", revision: 1 } });
  assert.equal(await saving, true);
  assert.equal(server.content, "第一段\n后续输入\n");
  assert.equal(session.state.serverRevision, 2);
});

test("out-of-order reads cannot replace the current revision or draft", async () => {
  const { session, transport, server, read } = fixture();
  await session.load();
  const stale = read();
  const response = deferred();
  transport.read = () => response.promise;
  const oldRead = session.load();
  server.content = "最新内容\n";
  server.revision = 3;
  transport.read = async () => read();
  await session.load();
  response.resolve(stale);
  await oldRead;
  assert.equal(session.state.serverRevision, 3);
  assert.equal(session.state.draftContent, "最新内容\n");
});

test("a failed save retains an error state and a retry can safely recover", async () => {
  const { session, transport, server } = fixture();
  await session.load();
  session.edit("需要保存的草稿\n");
  const write = transport.write;
  transport.write = async () => {
    throw new Error("network unavailable");
  };
  assert.equal(await session.save(), false);
  assert.equal(session.phase, "error");
  assert.equal(session.state.draftContent, "需要保存的草稿\n");
  assert.equal(server.content, "原文\n");
  transport.write = write;
  assert.equal(await session.save(), true);
  assert.equal(session.phase, "clean");
});

test("a committed edit whose original write failed retries the same operation before saving further typing", async () => {
  const { session, transport, server, requests } = fixture();
  await session.load();
  const write = transport.write;
  let committed;
  const ids = [];
  transport.write = async (operation) => {
    ids.push(operation.operationId);
    if (!committed) {
      committed = await write(operation);
      throw Object.assign(new Error("original file temporarily unavailable"), {
        code: "source_file_write_failed"
      });
    }
    if (operation.operationId === ids[0]) return committed;
    return write(operation);
  };
  session.edit("第一次修改");
  assert.equal(await session.save(), false);
  assert.equal(server.revision, 1);
  await session.load();
  assert.equal(session.state.conflict, null);
  session.edit("第一次修改和后续输入");
  assert.equal(await session.save(), true);
  assert.equal(ids[0], ids[1]);
  assert.equal(requests.length, 2);
  assert.equal(server.revision, 2);
  assert.equal(server.content, "第一次修改和后续输入");
});

test("even a clean original-file session verifies its save and retains errors until retry succeeds", async () => {
  const { session, transport, read } = fixture();
  const source = {
    path: "/Documents/note.md",
    format: "markdown",
    contentVersion: "a".repeat(64),
    savedRevision: 0
  };
  transport.read = async () => ({ ...read(), resource: { ...read().resource, sourceFile: source } });
  await session.load();
  transport.saveSource = async () => {
    throw new Error("original file changed externally");
  };
  assert.equal(session.dirty, false);
  assert.equal(await session.save(), false);
  assert.match(session.state.error, /original file changed externally/);
  transport.saveSource = async (revision) => {
    assert.equal(revision, 0);
    return { resource: { ...read().resource, sourceFile: source } };
  };
  assert.equal(await session.save(), true);
  assert.equal(session.state.error, null);
});

test("a conflict pauses writes until explicit merge or discard", async () => {
  const { session, server, requests } = fixture();
  await session.load();
  session.edit("我的草稿\n");
  server.content = "别人已保存的内容\n";
  server.revision = 1;
  await session.load();
  assert.equal(await session.save(), false);
  assert.equal(requests.length, 0);
  session.edit("合并后的内容\n");
  assert.equal(await session.merge(), true);
  assert.equal(requests[0].baseRevision, 1);
  session.edit("决定放弃的草稿\n");
  await session.load({ discardDraft: true });
  assert.equal(session.state.draftContent, "合并后的内容\n");
  assert.equal(session.phase, "clean");
});

test("undo preserves unsaved typing and requires an explicit merge", async () => {
  const { session, server } = fixture();
  await session.load();
  session.edit("已保存\n");
  await session.save();
  session.edit("尚未保存的工作\n");
  await session.undo();
  assert.equal(server.content, "原文\n");
  assert.equal(session.state.draftContent, "尚未保存的工作\n");
  assert.equal(session.phase, "conflict");
});

test("repeated undo clicks waiting on the same save issue only one undo", async () => {
  const { session, transport, server } = fixture();
  await session.load();
  const writing = deferred();
  const undoing = deferred();
  const write = transport.write;
  const undo = transport.undo;
  let undoCalls = 0;
  transport.write = async (operation) => {
    await writing.promise;
    return write(operation);
  };
  transport.undo = async () => {
    undoCalls++;
    await undoing.promise;
    return undo();
  };
  session.edit("需要先保存\n");
  const saving = session.save();
  const first = session.undo();
  const second = session.undo();
  writing.resolve();
  await saving;
  assert.equal(session.phase, "undoing");
  assert.equal(undoCalls, 1);
  undoing.resolve();
  await Promise.all([first, second]);
  assert.equal(server.revision, 2);
  assert.equal(session.phase, "clean");
});

test("late responses after disposal cannot notify or mutate the detached editor", async () => {
  const { session, transport, read } = fixture();
  await session.load();
  const response = deferred();
  transport.read = () => response.promise;
  const loading = session.load();
  const state = session.state;
  session.dispose();
  response.resolve({ ...read(), resource: { ...read().resource, revision: 4 } });
  await loading;
  assert.equal(session.state, state);
});
