import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const policyBytes = readFileSync(new URL("./cli-ui-policy.json", import.meta.url));
const policy = JSON.parse(policyBytes);
const failure = (cause) =>
  new Error(
    "CoworkOS Agent 的终端界面兼容性校验失败；请使用 Node >=22.19.0 并重新安装或构建当前 CLI。原会话已保留。",
    { cause }
  );

/** Read-only: called before profiles, sessions, Task/owner/lease and supervisor preparation. */
export function preflightCliUi({
  piPackageDir,
  manifestPath = new URL("../dist/cli-ui-manifest.json", import.meta.url)
} = {}) {
  try {
    if (typeof nodeModule.registerHooks !== "function") throw new Error("module.registerHooks unavailable");
    const root =
      piPackageDir ?? fileURLToPath(new URL("../", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const metadata = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    if (metadata.name !== "@earendil-works/pi-coding-agent" || metadata.version !== policy.sdkVersion)
      throw new Error("SDK version mismatch");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.policySha256 !== hash(policyBytes) ||
      manifest.offsetUnit !== "UTF-16" ||
      manifest.sdkVersion !== policy.sdkVersion ||
      manifest.entry !== policy.entry ||
      manifest.target !== policy.target ||
      JSON.stringify(manifest.files) !== JSON.stringify(policy.files) ||
      !Array.isArray(manifest.spans) ||
      manifest.spans.length !== policy.methods.length ||
      hash(JSON.stringify(manifest.spans)) !== policy.spansSha256
    )
      throw new Error("UI manifest mismatch");
    for (const [file, expected] of Object.entries(policy.files))
      if (hash(readFileSync(resolve(root, file))) !== expected) throw new Error("SDK file mismatch");
    const source = readFileSync(resolve(root, policy.target), "utf8");
    const ids = new Set();
    for (const [index, span] of manifest.spans.entries()) {
      if (
        !policy.methods.includes(span.id) ||
        ids.has(span.id) ||
        !Number.isInteger(span.start) ||
        !Number.isInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        typeof span.original !== "string" ||
        typeof span.replacement !== "string" ||
        source.slice(span.start, span.end) !== span.original ||
        span.original === span.replacement ||
        (index > 0 && span.start < manifest.spans[index - 1].end)
      )
        throw new Error("UI span mismatch");
      ids.add(span.id);
    }
    return {
      entryURL: pathToFileURL(resolve(root, policy.entry)).href,
      targetURL: pathToFileURL(resolve(root, policy.target)).href,
      manifest
    };
  } catch (cause) {
    throw failure(cause);
  }
}

/** No global output filters; all non-target modules are delegated unchanged. */
export function installCliUiHook(compatibility, onReady, shellTargets = []) {
  const { targetURL, manifest } = compatibility;
  return installCliSourceHooks(
    [
      ...shellTargets,
      { targetURL, sourceSha256: manifest.files[manifest.target], spans: manifest.spans, failure }
    ],
    onReady,
    targetURL
  );
}

/** Compose bounded projections against the same original source, never each other's output. */
export function installCliSourceHooks(targets, onReady, readyURL) {
  const byURL = new Map();
  for (const target of targets) {
    const previous = byURL.get(target.targetURL);
    if (previous && previous.sourceSha256 !== target.sourceSha256)
      throw failure(new Error("Conflicting SDK source hashes"));
    const spans = [...(previous?.spans ?? []), ...target.spans].sort((a, b) => a.start - b.start);
    if (spans.some((span, index) => index > 0 && span.start < spans[index - 1].end))
      throw failure(new Error("Overlapping SDK projections"));
    byURL.set(target.targetURL, { ...target, spans });
  }
  return nodeModule.registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      const target = byURL.get(url);
      if (!target) return result;
      try {
        const source =
          typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
        if (hash(source) !== target.sourceSha256) throw new Error("SDK changed after preflight");
        let transformed = source;
        for (const span of [...target.spans].reverse()) {
          if (source.slice(span.start, span.end) !== span.original)
            throw new Error("SDK span changed after preflight");
          transformed = transformed.slice(0, span.start) + span.replacement + transformed.slice(span.end);
        }
        if (url === readyURL) onReady?.();
        return { ...result, source: transformed };
      } catch (cause) {
        throw (target.failure ?? failure)(cause);
      }
    }
  });
}
