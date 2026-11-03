import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  cp,
  readdir,
  symlink,
  chmod,
  utimes,
  access,
  realpath
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const { createManagedUpdateInstaller, managedUpdateLaunch } = createRequire(import.meta.url)(
  "../desktop/update-install.cjs"
);
const modulePath = resolve("desktop/update-install.cjs");
const expectedId = "org.atria.update.fixture";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function app(directory, version = "1.0.0", extra = {}) {
  await mkdir(join(directory, "Contents/MacOS"), { recursive: true });
  await mkdir(join(directory, "Contents/Resources/app"), { recursive: true });
  await writeFile(join(directory, "Contents/MacOS/CoworkOS"), "native-fixture");
  await writeFile(join(directory, "Contents/Resources/app/package.json"), JSON.stringify({ version }));
  await writeFile(
    join(directory, "Contents/Info.plist"),
    JSON.stringify({
      CFBundleIdentifier: expectedId,
      CFBundleShortVersionString: version,
      CFBundleVersion: version,
      CFBundleExecutable: "CoworkOS",
      ...extra
    })
  );
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atria-managed-update-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, "Applications"),
    target = join(parent, "Portable CoworkOS.app"),
    source = join(root, "source/CoworkOS.app"),
    data = join(root, "profile"),
    archive = join(root, "CoworkOS-1.1.0-mac-arm64.dmg");
  await mkdir(parent);
  await mkdir(data);
  await app(target);
  await app(source, "1.1.0");
  const bytes = Buffer.from("fixture image");
  await writeFile(archive, bytes);
  const check = { version: "1.1.0", asset: { sha256: hash(bytes), size: bytes.length } };
  const calls = [];
  const runner = async (command, args, { signal } = {}) => {
    signal?.throwIfAborted();
    calls.push({ command, args });
    if (command.endsWith("PlistBuddy"))
      return { stdout: String(JSON.parse(await readFile(args.at(-1), "utf8"))[args[1].slice(7)]) };
    if (command.endsWith("lipo")) return { stdout: "arm64" };
    if (command.endsWith("codesign")) {
      await access(join(args.at(-1), "Contents/MacOS/CoworkOS"));
      return { stdout: "" };
    }
    if (command.endsWith("hdiutil")) {
      if (args[0] === "attach")
        await cp(source, join(args[args.indexOf("-mountpoint") + 1], "CoworkOS.app"), { recursive: true });
      return { stdout: "" };
    }
    if (command.endsWith("ditto")) {
      await cp(args[0], args[1], { recursive: true, verbatimSymlinks: true });
      return { stdout: "" };
    }
    throw Error("unexpected command " + command);
  };
  const options = {
    executable: join(target, "Contents/MacOS/CoworkOS"),
    userData: data,
    platform: "darwin",
    arch: "arm64",
    expectedId,
    runner
  };
  const installer = createManagedUpdateInstaller(options);
  t.after(() => installer.dispose());
  return { root, parent, target, source, data, archive, check, calls, runner, options, installer };
}
test("managed staging verifies the archive and app before preparing an untouched portable installation", async (t) => {
  const f = await fixture(t);
  await f.installer.stage({ archive: f.archive, check: f.check });
  assert.equal(
    JSON.parse(await readFile(join(f.target, "Contents/Resources/app/package.json"))).version,
    "1.0.0"
  );
  const stage = (await readdir(f.parent)).find(
    (name) => name.startsWith(".atria-update-") && !name.startsWith(".atria-update-lock-")
  );
  const request = JSON.parse(await readFile(join(f.parent, stage, "request.json")));
  assert.equal(request.target, f.target);
  assert.equal(request.version, "1.1.0");
  assert.equal(request.userData, f.data);
  assert.equal(
    JSON.parse(await readFile(join(request.candidate, "Contents/Resources/app/package.json"))).version,
    "1.1.0"
  );
  assert.ok(f.calls.some((c) => c.command.endsWith("hdiutil") && c.args.includes("-readonly")));
  await f.installer.dispose();
  assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
});
test("archive digest and byte mismatches fail before mounting and leave current installation intact", async (t) => {
  for (const asset of [
    { sha256: "0".repeat(64), size: 13 },
    { sha256: hash(Buffer.from("fixture image")), size: 999 }
  ]) {
    const f = await fixture(t);
    await assert.rejects(f.installer.stage({ archive: f.archive, check: { ...f.check, asset } }), /校验失败/);
    assert.ok(!f.calls.some((c) => c.command.endsWith("hdiutil")));
    assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
  }
});
test("wrong bundle identity, exact version, architecture and invalid signature are rejected without replacing", async (t) => {
  for (const kind of ["id", "version", "package", "arch", "signature"]) {
    const f = await fixture(t);
    if (kind === "id" || kind === "version")
      await app(
        f.source,
        "1.1.0",
        kind === "id" ? { CFBundleIdentifier: "org.other.app" } : { CFBundleVersion: "1.1.1" }
      );
    if (kind === "package")
      await writeFile(
        join(f.source, "Contents/Resources/app/package.json"),
        JSON.stringify({ version: "9.9.9" })
      );
    const runner = async (command, args, options) => {
      if (command.endsWith("lipo") && kind === "arch" && args.at(-1).startsWith(f.parent + "/.atria-update-"))
        return { stdout: "x86_64" };
      if (
        command.endsWith("codesign") &&
        kind === "signature" &&
        args.at(-1).startsWith(f.parent + "/.atria-update-")
      )
        throw Error("invalid native signature");
      return f.runner(command, args, options);
    };
    const installer = createManagedUpdateInstaller({ ...f.options, runner });
    t.after(() => installer.dispose());
    await assert.rejects(installer.stage({ archive: f.archive, check: f.check }));
    assert.equal(
      JSON.parse(await readFile(join(f.target, "Contents/Resources/app/package.json"))).version,
      "1.0.0"
    );
    assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
  }
});
test("symlinked current app, archive, parent and external bundle links fail closed", async (t) => {
  for (const kind of ["target", "archive", "parent", "internal"]) {
    const f = await fixture(t);
    let installer = f.installer,
      archive = f.archive;
    if (kind === "target") {
      const alias = join(f.parent, "Alias.app");
      await symlink(f.target, alias);
      installer = createManagedUpdateInstaller({
        ...f.options,
        executable: join(alias, "Contents/MacOS/CoworkOS")
      });
    }
    if (kind === "parent") {
      const alias = join(f.root, "Alias");
      await symlink(f.parent, alias);
      installer = createManagedUpdateInstaller({
        ...f.options,
        executable: join(alias, "Portable CoworkOS.app/Contents/MacOS/CoworkOS")
      });
    }
    if (kind === "archive") {
      archive = join(f.root, "alias.dmg");
      await symlink(f.archive, archive);
    }
    if (kind === "internal") await symlink(f.archive, join(f.source, "Contents/external"));
    t.after(() => installer.dispose());
    await assert.rejects(installer.stage({ archive, check: f.check }), /符号链接|实际文件/);
    assert.equal(
      JSON.parse(await readFile(join(f.target, "Contents/Resources/app/package.json"))).version,
      "1.0.0"
    );
  }
});
test("parallel staging holds one per-target owner lock and cancellation removes only its own staged files", async (t) => {
  const f = await fixture(t);
  await f.installer.stage({ archive: f.archive, check: f.check });
  const second = createManagedUpdateInstaller(f.options);
  t.after(() => second.dispose());
  await assert.rejects(second.stage({ archive: f.archive, check: f.check }), /另一个应用更新/);
  assert.equal((await readdir(f.parent)).filter((name) => name.startsWith(".atria-update-lock-")).length, 1);
  await f.installer.dispose();
  assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
});
test("unwritable application directory provides an actionable non-elevated installation error", async (t) => {
  const f = await fixture(t);
  await chmod(f.parent, 0o500);
  try {
    await assert.rejects(f.installer.stage({ archive: f.archive, check: f.check }), /不可写.*Applications/);
  } finally {
    await chmod(f.parent, 0o700);
  }
});
test("disposing an active preparation aborts its process and never replaces the running App", async (t) => {
  const f = await fixture(t);
  let began;
  const started = new Promise((resolve) => {
    began = resolve;
  });
  const installer = createManagedUpdateInstaller({
    ...f.options,
    runner: async (command, args, options) => {
      if (command.endsWith("hdiutil") && args[0] === "attach") {
        began();
        await new Promise((resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
        );
      }
      return f.runner(command, args, options);
    }
  });
  const staging = installer.stage({ archive: f.archive, check: f.check });
  const rejected = assert.rejects(staging, /abort/i);
  await started;
  await installer.dispose();
  await rejected;
  assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
});
test("update launch argument validation refuses duplicate and unrelated request paths", () => {
  assert.equal(managedUpdateLaunch({ args: ["app"] }), undefined);
  assert.throws(
    () =>
      managedUpdateLaunch({
        args: ["app", "--atria-update-request", "one", "--atria-update-request", "two"]
      }),
    /参数无效/
  );
});

const native = process.platform === "darwin" && process.env.TEST_ATRIA_MANAGED_UPDATE_NATIVE === "1";
test(
  "native disposable App update waits for owner exit, swaps, launches and rolls back a failed startup",
  { skip: !native, timeout: 120_000 },
  async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atria-managed-native-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const identifier = "org.atria.update.fixture." + process.pid;
    const binary = join(root, "fixture");
    const source = join(root, "fixture.m");
    await writeFile(
      source,
      '#import <Foundation/Foundation.h>\n#include <unistd.h>\nint main(int argc,char **argv){@autoreleasepool{NSString *request=nil;for(int i=1;i+1<argc;i++)if(!strcmp(argv[i],"--atria-update-request"))request=[NSString stringWithUTF8String:argv[i+1]];if(request){NSData *data=[NSData dataWithContentsOfFile:request];NSDictionary *c=[NSJSONSerialization JSONObjectWithData:data options:0 error:nil];char command[128],start[256]={0};snprintf(command,sizeof(command),"/bin/ps -p %d -o lstart=",getpid());setenv("LC_ALL","C",1);FILE *stream=popen(command,"r");if(stream){fgets(start,sizeof(start),stream);pclose(stream);}NSString *stamp=[[NSString stringWithUTF8String:start] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];NSDictionary *v=@{@"requestId":c[@"requestId"],@"pid":@(getpid()),@"version":c[@"version"],@"start":stamp,@"profile":[NSString stringWithUTF8String:getenv("COWORK_DESKTOP_DATA")?:""],@"nodeMode":[NSString stringWithUTF8String:getenv("ELECTRON_RUN_AS_NODE")?:""]};NSData *out=[NSJSONSerialization dataWithJSONObject:v options:0 error:nil];[out writeToFile:[c[@"stage"] stringByAppendingPathComponent:@"launch.json"] atomically:YES];if([[NSFileManager defaultManager] fileExistsAtPath:[[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:@"fail-start"]]){NSMutableDictionary *bad=[v mutableCopy];bad[@"pid"]=@1;[[NSJSONSerialization dataWithJSONObject:bad options:0 error:nil] writeToFile:[c[@"stage"] stringByAppendingPathComponent:@"ready.json"] atomically:YES];return 78;}[out writeToFile:[c[@"stage"] stringByAppendingPathComponent:@"ready.json"] atomically:YES];sleep(10);}else{NSString *profile=[NSString stringWithUTF8String:getenv("COWORK_DESKTOP_DATA")?:""];[profile writeToFile:@"ROLLBACK_PROFILE_MARKER" atomically:YES encoding:NSUTF8StringEncoding error:nil];}return 0;}}\n'.replace(
        "ROLLBACK_PROFILE_MARKER",
        join(root, "rollback-profile.txt")
      )
    );
    await execute("/usr/bin/clang", ["-framework", "Foundation", source, "-o", binary], { timeout: 60_000 });
    for (const rollback of [false, true])
      await t.test(
        rollback ? "rollback after no ready acknowledgement" : "successful startup acknowledgment",
        async () => {
          const directory = join(root, rollback ? "rollback" : "success"),
            parent = join(directory, "Applications"),
            target = join(parent, "Portable CoworkOS.app"),
            image = join(directory, "image"),
            candidate = join(image, "CoworkOS.app"),
            data = join(directory, "profile");
          await mkdir(parent, { recursive: true });
          await mkdir(data);
          await app(target, "1.0.0");
          await app(candidate, "1.1.0");
          for (const [bundle, version] of [
            [target, "1.0.0"],
            [candidate, "1.1.0"]
          ]) {
            await cp(binary, join(bundle, "Contents/MacOS/CoworkOS"));
            await writeFile(
              join(bundle, "Contents/Info.plist"),
              '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>' +
                identifier +
                "</string><key>CFBundleName</key><string>CoworkOS Update Fixture</string><key>CFBundleExecutable</key><string>CoworkOS</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>" +
                version +
                "</string><key>CFBundleVersion</key><string>" +
                version +
                "</string><key>LSUIElement</key><true/></dict></plist>"
            );
            if (rollback && bundle === candidate)
              await writeFile(join(bundle, "Contents/Resources/fail-start"), "fixture");
            await execute("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);
          }
          const archive = join(directory, "update.dmg");
          await execute(
            "/usr/bin/hdiutil",
            ["create", "-srcfolder", image, "-format", "UDZO", "-o", archive],
            { timeout: 60_000 }
          );
          const bytes = await readFile(archive),
            check = { version: "1.1.0", asset: { sha256: hash(bytes), size: bytes.length } };
          const driver = join(directory, "owner.cjs");
          await writeFile(
            driver,
            "const {createManagedUpdateInstaller}=require(" +
              JSON.stringify(modulePath) +
              ");(async()=>{const installer=createManagedUpdateInstaller(" +
              JSON.stringify({
                executable: join(target, "Contents/MacOS/CoworkOS"),
                userData: data,
                expectedId: identifier,
                arch: "arm64",
                helperExecutable: process.execPath,
                readyTimeout: 2000,
                exitTimeout: 10000
              }) +
              ");await installer.stage(" +
              JSON.stringify({ archive, check }) +
              ");await installer.schedule();})().catch(e=>{console.error(e);process.exitCode=1;});"
          );
          await execute(process.execPath, [driver], { timeout: 45_000 });
          let result;
          const started = Date.now();
          while (Date.now() - started < 20_000) {
            result = JSON.parse(
              await readFile(join(data, "updates/install-result.json"), "utf8").catch(() => "{}")
            );
            if (["installed", "rolled-back", "failed"].includes(result.phase)) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.equal(result.phase, rollback ? "rolled-back" : "installed", JSON.stringify(result));
          assert.equal(
            JSON.parse(await readFile(join(target, "Contents/Resources/app/package.json"))).version,
            rollback ? "1.0.0" : "1.1.0"
          );
          await execute("/usr/bin/codesign", ["--verify", "--deep", "--strict", target]);
          if (!rollback) {
            const launch = JSON.parse(await readFile(join(result.backup, "../launch.json")));
            assert.equal(launch.profile, data);
            assert.equal(launch.nodeMode, "");
            process.kill(launch.pid, "SIGTERM");
            assert.equal(
              JSON.parse(await readFile(join(result.backup, "Contents/Resources/app/package.json"))).version,
              "1.0.0"
            );
          } else {
            const end = Date.now() + 5000;
            while (Date.now() < end) {
              try {
                if ((await readFile(join(root, "rollback-profile.txt"), "utf8")) === data) break;
              } catch {}
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal(await readFile(join(root, "rollback-profile.txt"), "utf8"), data);
          }
          await execute(
            "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
            ["-u", target]
          );
        }
      );
  }
);

test("fresh damaged owner locks reject competing work and abandoned empty or corrupt locks recover safely", async (t) => {
  for (const corrupt of [false, true]) {
    const f = await fixture(t);
    const lock = join(
      f.parent,
      ".atria-update-lock-" + createHash("sha256").update(f.target).digest("hex").slice(0, 20)
    );
    await mkdir(lock, { mode: 0o700 });
    if (corrupt) await writeFile(join(lock, "owner.json"), "{broken");
    await assert.rejects(f.installer.stage({ archive: f.archive, check: f.check }), /安装锁/);
    assert.equal(
      JSON.parse(await readFile(join(f.target, "Contents/Resources/app/package.json"))).version,
      "1.0.0"
    );
    const old = new Date(Date.now() - 11 * 60_000);
    await utimes(lock, old, old);
    await f.installer.stage({ archive: f.archive, check: f.check });
    await f.installer.dispose();
    assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
  }
});
test("already prepared updates reject a second stage and damaged candidates can be discarded for a fresh download", async (t) => {
  const f = await fixture(t);
  await f.installer.stage({ archive: f.archive, check: f.check });
  await assert.rejects(f.installer.stage({ archive: f.archive, check: f.check }), /准备就绪/);
  const directory = (await readdir(f.parent)).find(
    (name) => name.startsWith(".atria-update-") && !name.startsWith(".atria-update-lock-")
  );
  await rm(join(f.parent, directory, "candidate.app"), { recursive: true });
  await assert.rejects(f.installer.schedule(), /ENOENT/);
  await f.installer.discard();
  assert.deepEqual(await readdir(f.parent), ["Portable CoworkOS.app"]);
  await f.installer.stage({ archive: f.archive, check: f.check });
});
