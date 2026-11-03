import { resolve } from "node:path";
import { LocalWorkspaceStore } from "../dist/src/workspace/workspace-store.js";
import { migrateLegacyTaskArtifacts } from "../dist/src/workspace/artifact-store.js";

const args = process.argv.slice(2);
let workspaceRoot, taskId;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--workspace" && args[i + 1]) workspaceRoot = resolve(args[++i]);
  else if (args[i] === "--task" && args[i + 1]) taskId = args[++i];
  else throw new Error("Usage: node scripts/migrate-artifacts.mjs --workspace <root> [--task <id>]");
}
if (!workspaceRoot) throw new Error("--workspace is required; build the project before running migration");
const store = new LocalWorkspaceStore(workspaceRoot);
const tasks = taskId ? [await store.readTask(taskId)] : await store.listTasks();
for (const task of tasks) {
  if (task.status === "running" || task.status === "waiting") {
    console.log(JSON.stringify({ taskId: task.taskId, skipped: "task may still be running; stop it before migrating" }));
    continue;
  }
  const result = await migrateLegacyTaskArtifacts({ workspaceRoot, taskId: task.taskId });
  console.log(JSON.stringify({ taskId: task.taskId, migrated: result.migrated, moved: result.moved, imported: result.imported }));
}
