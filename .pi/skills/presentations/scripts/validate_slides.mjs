#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./audit_slides.py", import.meta.url));
const result = spawnSync(process.env.COWORK_PYTHON_PATH ?? "python3", [script, ...process.argv.slice(2)], {
  stdio: "inherit"
});
if (result.error) console.error("PPTX audit requires Python 3:", result.error.message);
process.exit(result.status ?? 1);
