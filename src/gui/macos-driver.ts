import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import type { GuiAction } from "./contracts.js";
import {
  ComputerUseError,
  type ComputerDriver,
  type ComputerFrame,
  type ComputerStatus,
  type ComputerWindow
} from "./computer-use.js";

export class MacComputerDriver implements ComputerDriver {
  constructor(
    private readonly executable = process.env.COWORK_COMPUTER_USE_EXECUTABLE ||
      resolve(process.env.COWORK_HARNESS_ROOT || process.cwd(), "dist/src/gui/atria-computer-use")
  ) {}
  private async request<T>(body: unknown, signal?: AbortSignal, timeoutMs = 15_000): Promise<T> {
    const acting = (body as { operation?: string }).operation === "act";
    signal?.throwIfAborted();
    if (process.platform !== "darwin")
      throw new ComputerUseError(503, "Computer Use 当前支持 macOS", "driver_unavailable");
    await access(this.executable, constants.X_OK).catch(() => {
      throw new ComputerUseError(
        503,
        "未找到 Computer Use 原生驱动，请运行 npm run build:computer-use",
        "driver_unavailable"
      );
    });
    return new Promise<T>((done, reject) => {
      const child = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let size = 0,
        failure: Error | undefined;
      const abort = () => {
        failure = Object.assign(new DOMException("Computer Use 操作已取消", "AbortError"), {
          errorCode: "cancelled",
          dispatchStatus: acting ? "unknown" : "not_sent",
          requiresObservation: acting
        });
        child.kill("SIGKILL");
      };
      const timer = setTimeout(() => {
        failure = new ComputerUseError(
          408,
          "Computer Use 操作超时",
          "driver_timeout",
          acting ? "unknown" : "not_sent",
          acting
        );
        child.kill("SIGKILL");
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) {
          failure = new ComputerUseError(
            502,
            "原生驱动响应超限",
            "invalid_driver_response",
            acting ? "unknown" : "not_sent",
            acting
          );
          child.kill("SIGKILL");
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("error", (error) => {
        failure = new ComputerUseError(503, error.message, "driver_unavailable");
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (failure) {
          reject(failure);
          return;
        }
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            error?: string;
            errorCode?: string;
            dispatchStatus?: string;
          };
          if (code !== 0 || result.error)
            throw new ComputerUseError(
              409,
              result.error || "原生驱动未完成操作",
              typeof result.errorCode === "string" && /^[a-z_]{1,64}$/.test(result.errorCode)
                ? result.errorCode
                : "native_rejected",
              acting
                ? result.dispatchStatus === "not_sent"
                  ? "not_sent"
                  : result.dispatchStatus === "sent"
                    ? "sent"
                    : "unknown"
                : "not_sent",
              acting
            );
          done(result as T);
        } catch (error) {
          reject(
            error instanceof ComputerUseError
              ? error
              : new ComputerUseError(
                  502,
                  "原生驱动返回无效 JSON",
                  "invalid_driver_response",
                  acting ? "unknown" : "not_sent",
                  acting
                )
          );
        }
      });
      child.stdin.end(JSON.stringify(body));
      if (signal?.aborted) abort();
    });
  }
  async status(signal?: AbortSignal): Promise<ComputerStatus> {
    if (process.platform !== "darwin")
      return {
        available: false,
        screenRecording: false,
        accessibility: false,
        windows: [],
        reason: "Computer Use 当前支持 macOS 桌面版"
      };
    return this.request<ComputerStatus>({ operation: "status" }, signal).catch((error) => ({
      available: false,
      screenRecording: false,
      accessibility: false,
      windows: [],
      reason: error instanceof Error ? error.message : "原生驱动不可用"
    }));
  }
  requestPermissions(permission: "screenRecording" | "accessibility") {
    // A person may spend longer than an ordinary operation confirming macOS UI.
    return this.request({ operation: "permissions", permission }, undefined, 5 * 60_000);
  }
  observe(target: ComputerWindow, signal: AbortSignal) {
    return this.request<ComputerFrame>({ operation: "observe", target }, signal);
  }
  async act(target: ComputerWindow, action: GuiAction, frame: ComputerFrame, signal: AbortSignal) {
    const element =
      action.type === "press" || action.type === "set_value"
        ? frame.accessibility?.elements.find((node) => node.elementId === action.elementId)
        : undefined;
    if ((action.type === "press" || action.type === "set_value") && !element)
      throw new ComputerUseError(409, "控件不属于本次观察", "stale_element", "not_sent", true);
    // Never pass the previous screenshot back across the native boundary.
    await this.request(
      {
        operation: "act",
        target,
        action,
        ...(element ? { element } : {}),
        frame: { width: frame.width, height: frame.height, frame: frame.frame }
      },
      signal
    );
  }
}
