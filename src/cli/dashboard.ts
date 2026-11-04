import { componentTokenProvider, validateComponentToken } from "../software/components/download.js";
import { componentReleaseRoot, privateComponentSource } from "../software/components/source.js";
import { createComponentService } from "../software/components/service.js";
import { readCoworkConfig } from "../runtime/config.js";
import { applyProxyEnvironment } from "../runtime/http-transport.js";
import { createDashboardApplication } from "../dashboard/application.js";

applyProxyEnvironment(readCoworkConfig());
const releaseRoot = componentReleaseRoot();
let componentToken = componentTokenProvider(releaseRoot)();
const dashboard = createDashboardApplication({
  components: createComponentService({ releaseRoot, githubToken: () => componentToken })
});
// This IPC channel belongs to the Electron parent, not the HTTP/Agent surface.
process.on("message", (value) => {
  if (!value || typeof value !== "object" || !("type" in value)) return;
  if (value.type === "dashboard.shutdown") {
    shutdown();
    return;
  }
  if (
    value.type === "components.auth" &&
    "requestId" in value &&
    typeof value.requestId === "string" &&
    "token" in value
  ) {
    try {
      if (privateComponentSource(releaseRoot)) componentToken = validateComponentToken(value.token);
      process.send?.({ type: "components.auth.reply", requestId: value.requestId });
    } catch {
      process.send?.({
        type: "components.auth.reply",
        requestId: value.requestId,
        error: "Invalid component credential"
      });
    }
    return;
  }
  if (value.type !== "computer.host") return;
  const message = value as { requestId?: unknown; input?: unknown };
  if (typeof message.requestId !== "string") return;
  void dashboard.computerHostRequest(message.input).then(
    (result) => process.send?.({ type: "computer.reply", requestId: message.requestId, result }),
    (error) =>
      process.send?.({
        type: "computer.reply",
        requestId: message.requestId,
        error: error instanceof Error ? error.message : "Computer Use 请求失败"
      })
  );
});
const port = Number(process.env.COWORK_UI_PORT ?? 3880);
dashboard.server.listen(port, "127.0.0.1", () => {
  console.log(`Cowork dashboard listening on ${dashboard.dashboardUrl}`);
  if (process.send) process.send({ type: "dashboard.ready", url: dashboard.dashboardUrl });
});
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forced = setTimeout(() => process.exit(130), 4_000);
  forced.unref();
  void dashboard.stop().then(() => {
    clearTimeout(forced);
    process.exit(0);
  });
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, shutdown);
