import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, realpath, writeFile, symlink, readdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { test } from "node:test";
import { executeForegroundCommand } from "../dist/src/tools/foreground-command.js";

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), "atria-foreground-output-"));
  const root = await realpath(temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    options: {
      cwd: root,
      shell: false,
      timeoutMs: 5000,
      maxOutputBytes: 64 * 1024 * 1024,
      previewBytes: 256,
      outputLogDirectory: join(root, "logs", "commands")
    }
  };
}

async function failure(promise) {
  return promise.then(
    () => assert.fail("command unexpectedly succeeded"),
    (error) => error
  );
}

async function ready(path) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      await stat(path);
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await wait(10);
    }
  }
  assert.fail("command fixture did not become ready");
}

test("large output preserves execution and full logs while previews retain bounded UTF-8 heads and tails", async (t) => {
  const { root, options } = await fixture(t);
  const stdout = "STDOUT_HEAD\n" + "中🚀".repeat(40000) + "\nSTDOUT_TAIL";
  const stderr = "STDERR_HEAD\n" + "📂文".repeat(25000) + "\nSTDERR_TAIL";
  const result = await executeForegroundCommand(
    process.execPath,
    [
      "-e",
      "const fs=require('node:fs');process.stdout.write('STDOUT_HEAD\\n'+'中🚀'.repeat(40000)+'\\nSTDOUT_TAIL');process.stderr.write('STDERR_HEAD\\n'+'📂文'.repeat(25000)+'\\nSTDERR_TAIL');fs.writeFileSync('DONE','yes');"
    ],
    options
  );
  assert.equal(await readFile(join(root, "DONE"), "utf8"), "yes");
  for (const [stream, expected] of [
    ["stdout", stdout],
    ["stderr", stderr]
  ]) {
    assert.ok(Buffer.byteLength(result[stream]) <= options.previewBytes);
    assert.equal(result[stream].isWellFormed(), true);
    assert.doesNotMatch(result[stream], /�/);
    assert.match(result[stream], new RegExp(`${stream.toUpperCase()}_HEAD`));
    assert.match(result[stream], new RegExp(`${stream.toUpperCase()}_TAIL`));
    assert.match(result[stream], /truncated/);
    assert.equal(result[`${stream}Bytes`], Buffer.byteLength(expected));
    assert.equal(result[`${stream}LogBytes`], Buffer.byteLength(expected));
    assert.equal(result[`${stream}Truncated`], true);
    assert.ok(isAbsolute(result[`${stream}Path`]));
    assert.equal(await readFile(result[`${stream}Path`], "utf8"), expected);
    if (process.platform !== "win32") assert.equal((await stat(result[`${stream}Path`])).mode & 0o777, 0o600);
  }
  assert.equal(result.logLimitExceeded, undefined);
});

test("short output is unchanged and concurrent commands receive private unique logs", async (t) => {
  const { options } = await fixture(t);
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      executeForegroundCommand(process.execPath, ["-e", `process.stdout.write('value-${index}')`], options)
    )
  );
  assert.equal(new Set(results.flatMap((result) => [result.stdoutPath, result.stderrPath])).size, 8);
  for (const [index, result] of results.entries()) {
    assert.equal(result.stdout, `value-${index}`);
    assert.equal(result.stderr, "");
    assert.equal(result.stdoutTruncated, false);
    assert.equal(result.stderrTruncated, false);
    assert.equal(await readFile(result.stdoutPath, "utf8"), result.stdout);
    assert.equal(await readFile(result.stderrPath, "utf8"), "");
    if (process.platform !== "win32")
      assert.equal((await stat(join(result.stdoutPath, ".."))).mode & 0o777, 0o700);
  }
});

test("explicit per-stream hard caps still fail, stop execution and bound disk bytes", async (t) => {
  const { root, options } = await fixture(t);
  for (const stream of ["stdout", "stderr"]) {
    const error = await failure(
      executeForegroundCommand(
        process.execPath,
        [
          "-e",
          `process.${stream}.write('x'.repeat(100000));setTimeout(()=>require('fs').writeFileSync('${stream}-DONE','bad'),3000);setInterval(()=>{},1000)`
        ],
        { ...options, maxOutputBytes: 4096, previewBytes: 128 }
      )
    );
    assert.match(error.message, /maxBuffer|output.*limit/i);
    assert.equal(error.timedOut, false);
    assert.equal(error.logLimitExceeded, true);
    assert.ok(error[`${stream}Bytes`] > 4096);
    assert.equal(error[`${stream}LogBytes`], 4096);
    assert.equal((await stat(error[`${stream}Path`])).size, 4096);
    assert.ok(Buffer.byteLength(error[stream]) <= 128);
    assert.equal(error[`${stream}Truncated`], true);
    await assert.rejects(stat(join(root, `${stream}-DONE`)), { code: "ENOENT" });
  }
});

test("legacy executor calls without preview retain the original bounded UTF-8 prefix", async (t) => {
  const { options } = await fixture(t);
  const error = await failure(
    executeForegroundCommand(
      process.execPath,
      ["-e", "process.stdout.write('中'.repeat(100));setInterval(()=>{},1000)"],
      { ...options, maxOutputBytes: 64, previewBytes: undefined, outputLogDirectory: undefined }
    )
  );
  assert.equal(error.stdout, "中".repeat(21));
  assert.equal(error.stdoutPath, undefined);
  assert.equal(error.logLimitExceeded, true);
});

test("invalid UTF-8 cannot expand a preview beyond its byte budget and logs retain raw bytes", async (t) => {
  const { options } = await fixture(t);
  const result = await executeForegroundCommand(
    process.execPath,
    ["-e", "process.stdout.write(Buffer.alloc(2000,255));process.stdout.write('END')"],
    { ...options, previewBytes: 128 }
  );
  assert.ok(Buffer.byteLength(result.stdout) <= 128);
  assert.equal(result.stdout.isWellFormed(), true);
  assert.match(result.stdout, /END$/);
  assert.deepEqual(
    await readFile(result.stdoutPath),
    Buffer.concat([Buffer.alloc(2000, 255), Buffer.from("END")])
  );
  assert.equal(result.stdoutBytes, 2003);
  assert.equal(result.stdoutLogBytes, 2003);
});

test("cancellation during log setup closes prepared files and does not start a command", async (t) => {
  const { root, options } = await fixture(t);
  const probe = await open(join(root, "setup-probe"), "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const controller = new AbortController();
  const realSync = prototype.sync;
  const settled = [];
  const injected = t.mock.method(prototype, "sync", async function (...args) {
    settled.push(this.fd);
    return realSync.apply(this, args);
  });
  const pending = failure(
    executeForegroundCommand(
      process.execPath,
      ["-e", "require('fs').writeFileSync('SETUP_CANCEL_SIDE_EFFECT','bad')"],
      { ...options, signal: controller.signal }
    )
  );
  controller.abort();
  const error = await pending;
  assert.equal(error.name, "AbortError");
  assert.equal(error.stdoutBytes, 0);
  assert.equal(error.stderrBytes, 0);
  assert.equal(settled.length, 2, "both prepared handles must finish their close path");
  injected.mock.restore();
  await assert.rejects(stat(join(root, "SETUP_CANCEL_SIDE_EFFECT")), { code: "ENOENT" });
});

test("nonzero exits, cancellation and timeout settle logs before returning their errors", async (t) => {
  const { root, options } = await fixture(t);
  const failed = await failure(
    executeForegroundCommand(
      process.execPath,
      [
        "-e",
        "process.stdout.write('before failure');process.stderr.write('error receipt');process.exitCode=7"
      ],
      options
    )
  );
  assert.equal(failed.code, 7);
  assert.equal(await readFile(failed.stdoutPath, "utf8"), "before failure");
  assert.equal(await readFile(failed.stderrPath, "utf8"), "error receipt");
  for (const mode of ["cancel", "timeout"]) {
    const controller = new AbortController();
    const pending = failure(
      executeForegroundCommand(
        process.execPath,
        [
          "-e",
          `process.stdout.write('${mode}-stdout');process.stderr.write('${mode}-stderr');require('fs').writeFileSync('${mode}-ready','yes');setInterval(()=>{},1000)`
        ],
        { ...options, timeoutMs: mode === "timeout" ? 600 : 0, signal: controller.signal }
      )
    );
    t.after(() => controller.abort());
    await ready(join(root, `${mode}-ready`));
    if (mode === "cancel") controller.abort();
    const error = await pending;
    assert.equal(error.timedOut, mode === "timeout");
    for (const stream of ["stdout", "stderr"]) {
      assert.equal(await readFile(error[`${stream}Path`], "utf8"), `${mode}-${stream}`);
      assert.equal(error[`${stream}LogBytes`], Buffer.byteLength(`${mode}-${stream}`));
    }
  }
});

test(
  "unsafe log directories fail before command side effects",
  { skip: process.platform === "win32" },
  async (t) => {
    const { root, options } = await fixture(t);
    const outside = join(root, "outside");
    await writeFile(outside, "not a directory");
    await assert.rejects(
      executeForegroundCommand(
        process.execPath,
        ["-e", "require('fs').writeFileSync('SHOULD_NOT_RUN','bad')"],
        { ...options, outputLogDirectory: outside }
      )
    );
    await rm(outside);
    await symlink(root, outside, "dir");
    await assert.rejects(
      executeForegroundCommand(
        process.execPath,
        ["-e", "require('fs').writeFileSync('SHOULD_NOT_RUN','bad')"],
        { ...options, outputLogDirectory: join(outside, "escaped") }
      ),
      /symbolic|symlink/i
    );
    await assert.rejects(stat(join(root, "SHOULD_NOT_RUN")), { code: "ENOENT" });
    await assert.rejects(stat(join(root, "escaped")), { code: "ENOENT" });
  }
);

test("disk write failure stops the command, closes logs and leaves later commands usable", async (t) => {
  const { root, options } = await fixture(t);
  const probe = await open(join(root, "prototype-probe"), "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const realWrite = prototype.write;
  const injected = t.mock.method(prototype, "write", async function (...args) {
    if (Buffer.isBuffer(args[0]) && args[0].includes(Buffer.from("DISK_FAILURE_TRIGGER")))
      throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    return realWrite.apply(this, args);
  });
  const error = await failure(
    executeForegroundCommand(
      process.execPath,
      ["-e", "process.stdout.write('DISK_FAILURE_TRIGGER');setInterval(()=>{},1000)"],
      options
    )
  );
  assert.match(error.message, /output.*log|log.*write/i);
  assert.match(String(error.cause), /space left|ENOSPC/i);
  assert.equal(error.timedOut, false);
  assert.equal((await stat(error.stdoutPath)).size, 0);
  assert.equal(error.stdoutLogBytes, 0);
  injected.mock.restore();
  const recovered = await executeForegroundCommand(
    process.execPath,
    ["-e", "process.stdout.write('recovered')"],
    options
  );
  assert.equal(await readFile(recovered.stdoutPath, "utf8"), "recovered");
  assert.ok((await readdir(options.outputLogDirectory)).length >= 2);
});

test("log flush failure preserves an observed zero command exit and closes both handles", async (t) => {
  const { root, options } = await fixture(t);
  const probe = await open(join(root, "flush-probe"), "wx", 0o600);
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const handles = [];
  const syncInjection = t.mock.method(prototype, "sync", async function () {
    handles.push(this);
    throw Object.assign(new Error("injected output flush failure"), { code: "EIO" });
  });
  const error = await failure(
    executeForegroundCommand(
      process.execPath,
      ["-e", "process.stdout.write('successful command');process.stderr.write('diagnostic')"],
      options
    )
  );
  assert.match(error.message, /flush\/close failed/);
  assert.match(String(error.cause), /injected output flush failure/);
  assert.equal(error.code, 0, "storage failure must preserve the actual command exit status");
  assert.equal(error.stdoutBytes, Buffer.byteLength("successful command"));
  assert.equal(error.stdoutLogBytes, error.stdoutBytes);
  assert.equal(error.stderrBytes, Buffer.byteLength("diagnostic"));
  assert.equal(error.stderrLogBytes, error.stderrBytes);
  assert.equal(await readFile(error.stdoutPath, "utf8"), "successful command");
  assert.equal(await readFile(error.stderrPath, "utf8"), "diagnostic");
  assert.equal(handles.length, 2, "sync errors must still close both log handles");
  assert.equal(new Set(handles).size, 2);
  for (const handle of handles) {
    assert.equal(handle.fd, -1);
    await assert.rejects(handle.stat(), { code: "EBADF" });
  }
  syncInjection.mock.restore();
  const recovered = await executeForegroundCommand(
    process.execPath,
    ["-e", "process.stdout.write('after flush failure')"],
    options
  );
  assert.equal(await readFile(recovered.stdoutPath, "utf8"), "after flush failure");
});
