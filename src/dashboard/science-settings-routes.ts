import type { IncomingMessage, ServerResponse } from "node:http";
import { readJsonBody, sendJson, HttpError } from "./http.js";
import { ScienceSettingsError, type createScienceSettings } from "./science-settings.js";
import { ScienceInstallationError } from "../runtime/science-installation.js";

/** The caller performs the normal local Host/Origin/session checks before dispatch. */
export async function handleScienceSettingsRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  settings: ReturnType<typeof createScienceSettings>
): Promise<boolean> {
  if (
    ![
      "/api/science-settings",
      "/api/science-settings/check",
      "/api/science-settings/environments",
      "/api/science-settings/install",
      "/api/science-settings/cancel"
    ].includes(url.pathname)
  )
    return false;
  const controller = new AbortController();
  const disconnect = () => {
    if (!response.writableEnded) controller.abort();
  };
  response.once("close", disconnect);
  try {
    if (url.pathname === "/api/science-settings" && request.method === "GET") {
      sendJson(response, 200, settings.status());
    } else if (url.pathname.endsWith("/environments") && request.method === "GET") {
      sendJson(response, 200, await settings.environments());
    } else if (request.method === "POST" && !url.pathname.endsWith("/environments")) {
      const input = await readJsonBody(request, 16 * 1024);
      const result = url.pathname.endsWith("/install")
        ? await settings.install(input)
        : url.pathname.endsWith("/cancel")
          ? await settings.cancelInstallation(input)
          : url.pathname.endsWith("/check")
            ? await settings.check(input, controller.signal)
            : await settings.save(input);
      if (!response.destroyed) sendJson(response, url.pathname.endsWith("/install") ? 202 : 200, result);
    } else sendJson(response, 405, { error: "method not allowed" });
  } catch (error) {
    if (!response.destroyed)
      sendJson(
        response,
        error instanceof ScienceSettingsError ||
          error instanceof ScienceInstallationError ||
          error instanceof HttpError
          ? error.status
          : 400,
        {
          error: error instanceof Error ? error.message : "科学计算设置操作失败",
          ...(error instanceof ScienceSettingsError || error instanceof ScienceInstallationError
            ? { code: error.code }
            : {})
        }
      );
  } finally {
    response.off("close", disconnect);
  }
  return true;
}
