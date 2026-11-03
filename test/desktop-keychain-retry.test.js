import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { createRetryableStorage } = require("../desktop/retryable-storage.cjs");
const { createModelSettings } = require("../desktop/model-settings.cjs");
const { desktopPaths } = require("../desktop/paths.cjs");

// A real pipe/process fixture models OSCrypt's process-local failure cache.
// It does not claim to exercise macOS authorization.
async function fixture(t, mode = "recover", timeout = 5000) {
  const root = await mkdtemp(join(tmpdir(), "atria-keychain-retry-test-"));
  const script = join(root, "worker.cjs");
  const counter = join(root, "attempts");
  await writeFile(
    script,
    `const fs=require('node:fs');
const readline=require('node:readline');
const counter=${JSON.stringify(counter)};
const attempt=Number(fs.existsSync(counter)?fs.readFileSync(counter,'utf8'):0)+1;
fs.writeFileSync(counter,String(attempt));
const mode=${JSON.stringify(mode)};
const lines=readline.createInterface({input:process.stdin});
lines.on('line',line=>{
 const r=JSON.parse(line);
 if(mode==='timeout')return;
 if(mode==='crash'){console.error('private-synthetic-key');process.exit(1);}
 let value;
 if(r.operation==='available')value=attempt>1;
 if(r.operation==='encrypt')value=Buffer.from('encrypted:'+r.value).toString('base64');
 if(r.operation==='decrypt'){
   const raw=Buffer.from(r.value,'base64').toString();
   if(!raw.startsWith('encrypted:')){process.stdout.write('atria-keychain:'+JSON.stringify({id:r.id,ok:false})+'\\n');return;}
   value=raw.slice(10);
 }
 process.stdout.write('atria-keychain:'+JSON.stringify({id:r.id,ok:true,value})+'\\n');
});`
  );
  const storage = createRetryableStorage({ executable: process.execPath, args: [script], timeout });
  t.after(async () => {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, storage, counter };
}

test("saving again starts a fresh keychain attempt and preserves settings on cancellation", async (t) => {
  const { root, storage, counter } = await fixture(t);
  const paths = desktopPaths("/fixture/install", root, {});
  await writeFile(paths.configPath, "{}\n");
  const settings = createModelSettings(paths, storage);
  const input = { baseUrl: "https://example.com/v1", model: "fixture", apiKey: "private-synthetic-key" };
  await assert.rejects(settings.save(input), /再次点击保存重试/);
  assert.equal(await readFile(paths.configPath, "utf8"), "{}\n");
  assert.equal(await storage.isEncryptionAvailable(), false);
  assert.equal(await readFile(counter, "utf8"), "1", "no automatic retry/prompt loop");
  const status = await settings.save(input);
  assert.equal(status.configured, true);
  assert.equal(await readFile(counter, "utf8"), "2", "second click uses a fresh process");
  assert.equal((await settings.read()).apiKey, input.apiKey);
  assert.equal((await readFile(paths.configPath, "utf8")).includes(input.apiKey), false);
  assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(status).includes(input.apiKey), false);
  await assert.rejects(storage.decryptString(Buffer.from("corrupt-ciphertext")), /存储访问失败/);
  assert.equal(
    (await settings.read()).apiKey,
    input.apiKey,
    "corrupt optional secret cannot poison model access"
  );
  assert.equal(await readFile(counter, "utf8"), "2", "ordinary reads do not automatically retry");
});

test("closing the App cancels an outstanding helper without waiting for its timeout", async (t) => {
  const { storage } = await fixture(t, "timeout", 60000);
  const pending = storage.encryptString("private-synthetic-key");
  const failed = assert.rejects(pending, /存储访问失败/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await storage.close();
  await failed;
  await assert.rejects(storage.isEncryptionAvailable(), /存储访问失败/);
});

test("helper timeout and process errors are bounded and do not echo secrets", async (t) => {
  for (const mode of ["timeout", "crash"]) {
    const { storage } = await fixture(t, mode, 150);
    await assert.rejects(storage.encryptString("private-synthetic-key"), (error) => {
      assert.match(error.message, /密钥存储访问失败/);
      assert.doesNotMatch(error.message, /private-synthetic-key/);
      return true;
    });
    await storage.retry();
    await assert.rejects(storage.isEncryptionAvailable(), /密钥存储访问失败/);
  }
});
