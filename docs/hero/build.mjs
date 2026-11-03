import { context, build } from "esbuild";
import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const source = dirname(fileURLToPath(import.meta.url));
const output = resolve(source, "../../.tmp/readme-hero");
await mkdir(output, { recursive: true });
await copyFile(resolve(source, "index.html"), resolve(output, "index.html"));
await copyFile(resolve(source, "../assets/readme-hero.png"), resolve(output, "static.png"));
await copyFile(
  resolve(source, "../../web/assets/fonts/InterVariable.woff2"),
  resolve(output, "InterVariable.woff2")
);
await copyFile(resolve(source, "react-bits/LICENSE.md"), resolve(output, "react-bits-LICENSE.md"));
await copyFile(resolve(source, "react-bits/SOURCES.md"), resolve(output, "react-bits-SOURCES.md"));
const options = {
  absWorkingDir: source,
  entryPoints: ["scene.jsx"],
  outdir: output,
  bundle: true,
  external: ["./InterVariable.woff2"],
  minify: true,
  jsx: "automatic",
  format: "esm",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "linked"
};
if (process.argv.includes("--serve")) {
  const session = await context(options);
  await session.watch();
  const { port } = await session.serve({ servedir: output, host: "127.0.0.1", port: 18742 });
  console.log(`CoworkOS hero preview: http://127.0.0.1:${port}`);
} else {
  await build(options);
  console.log("Hero built in .tmp/readme-hero");
}
