import { createComponentService } from "../dist/src/software/components/service.js";
import { componentIds } from "../dist/src/software/components/paths.js";
export async function runComponents(args) {
  const [action = "list", id, ...extra] = args;
  if (action === "--help" || action === "-h") {
    console.log(
      "Usage: coworkos components list [--refresh] | install|upgrade|cancel|enable|disable|uninstall cadquery|blender|pptist\nInstall progress is reported until completion; Ctrl-C cancels safely. ATRIA_COMPONENTS_HOME selects user-owned storage. For private releases, explicitly set ATRIA_COMPONENTS_GITHUB_TOKEN with Contents: read repository access. Never pass tokens as command arguments."
    );
    return;
  }
  if (
    extra.length ||
    (action === "list" && id && id !== "--refresh") ||
    (action !== "list" && !componentIds.includes(id))
  )
    throw new Error("Invalid component command; use coworkos components --help");
  const service = createComponentService();
  if (action === "list") return console.log(JSON.stringify(await service.list(id === "--refresh"), null, 2));
  if (action === "install" || action === "upgrade") {
    const interrupt = () => {
      void service.action(id, "cancel");
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    const timer = setInterval(() => {
      void service.status(id).then((state) => console.error(JSON.stringify(state)));
    }, 1000);
    try {
      await service.install(id, action === "upgrade");
      console.log(JSON.stringify(await service.status(id)));
    } finally {
      clearInterval(timer);
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      await service.stop();
    }
  } else console.log(JSON.stringify(await service.action(id, action)));
}
