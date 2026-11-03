import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function buildDocumentMarkdown() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const target = new URL("../web/assets/markdown/generated/", import.meta.url);
  await mkdir(target, { recursive: true });
  await build({
    stdin: {
      contents: 'export { marked } from "marked"; export { default as DOMPurify } from "dompurify";',
      resolveDir: root
    },
    outfile: fileURLToPath(new URL("dependencies.js", target)),
    bundle: true,
    format: "esm",
    platform: "browser",
    legalComments: "eof"
  });
  for (const [name, license] of [
    ["marked", "LICENSE"],
    ["dompurify", "LICENSE"]
  ]) {
    await copyFile(
      new URL(`../node_modules/${name}/${license}`, import.meta.url),
      new URL(`${name}-LICENSE.txt`, target)
    );
  }
}
