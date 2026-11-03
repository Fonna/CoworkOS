import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const policy = JSON.parse(readFileSync(new URL("./cli-shell-policy.json", import.meta.url), "utf8"));
const hash = (source) => createHash("sha256").update(source).digest("hex");
const failure = (cause) =>
  new Error(
    "CoworkOS Agent 的命令执行兼容性校验失败；请使用 Node >=22.19.0 并重新安装或构建当前 CLI。原会话已保留。",
    { cause }
  );

/** Only new SDK-produced paths and the generic caller identity are projected. */
export function preflightCliShell({ piPackageDir } = {}) {
  try {
    if (typeof nodeModule.registerHooks !== "function") throw new Error("module.registerHooks unavailable");
    const root =
      piPackageDir ?? fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    if (metadata.name !== "@earendil-works/pi-coding-agent" || metadata.version !== policy.sdkVersion)
      throw new Error("SDK version mismatch");
    const targets = Object.entries(policy.files).map(([file, expected]) => {
      const source = readFileSync(resolve(root, file), "utf8");
      if (hash(source) !== expected) throw new Error("SDK shell source mismatch: " + file);
      const spans = policy.changes
        .filter((change) => change.file === file)
        .map((change) => {
          const start = source.indexOf(change.original);
          if (
            start < 0 ||
            source.indexOf(change.original, start + 1) >= 0 ||
            change.original === change.replacement
          )
            throw new Error("SDK shell source must match exactly once: " + change.id);
          return { ...change, start, end: start + change.original.length };
        });
      if (!spans.length) throw new Error("Missing shell projection");
      return { targetURL: pathToFileURL(resolve(root, file)).href, sourceSha256: expected, spans, failure };
    });
    return { entryURL: pathToFileURL(resolve(root, policy.entry)).href, targets };
  } catch (cause) {
    throw failure(cause);
  }
}
