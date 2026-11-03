import {
  ApplicationError,
  type ContextRequest,
  type ContextSummary,
  type OperationResult,
  type WorkbenchRuntimeAdapter
} from "../../types.js";
import { buildFreecadMcpServerSpec } from "./mcp.js";
import { resolveFreecadHost, resolveFreecadPort } from "./paths.js";

/**
 * The `freecad-harness` application.
 *
 * Unlike the native `blender` / `cad` applications (which own a modeling engine
 * under `src/software/`), a harness application owns no geometry. Its whole
 * purpose is to surface the tools of an external stdio MCP server — upstream
 * freecad-mcp — so the agent can drive a *running* FreeCAD. The resource is a
 * tiny session descriptor (`{ host, port }`) that exists only so the platform
 * has something to bind: binding it starts the MCP server, and the server's
 * tools become the application's tools.
 *
 * No in-process `agentTools` are declared for the same reason: the tools come
 * from the MCP server, discovered by the application bridge once the resource
 * is bound. The modeling workflow itself lives in `.pi/skills/freecad-harness`.
 */

const APP = "freecad-harness";
const KIND = "application/freecad-session+json";

interface HarnessSession {
  host: string;
  port: number;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function defaultSession(): HarnessSession {
  return { host: resolveFreecadHost(), port: resolveFreecadPort() };
}

/** Normalize an arbitrary value into a session descriptor, filling absent/illegal fields. */
function normalizeSession(input: unknown): HarnessSession {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    host: typeof value.host === "string" && value.host.trim() ? value.host.trim() : resolveFreecadHost(),
    port: validPort(value.port) ? value.port : resolveFreecadPort()
  };
}

export function createFreecadHarnessAdapter(): WorkbenchRuntimeAdapter {
  return {
    definition: {
      appType: APP,
      displayName: "FreeCAD Harness",
      catalogVisibility: "compatibility",
      version: "1",
      resourceKinds: [KIND],
      fileExtensions: { [KIND]: ".freecad-session.json" },
      capabilities: ["view", "edit", "agent-commands"],
      operationSchemas: {
        "session.update": {
          description: "更新 FreeCAD 会话连接目标",
          required: [],
          optional: ["host", "port"]
        }
      },
      exportFormats: [],
      creationHint:
        "FreeCAD Harness 通过 freecad-mcp 驱动正在运行的 FreeCAD。先启动 FreeCAD 并加载 MCP addon（默认 XML-RPC 端口 9875），再绑定本会话资源。",
      mcpServer: buildFreecadMcpServerSpec(),
      skillRoots: [".pi/skills/freecad-harness"]
    },

    createContent({ initialContent }) {
      return initialContent === undefined || initialContent === null
        ? defaultSession()
        : normalizeSession(initialContent);
    },

    serialize(content) {
      return `${JSON.stringify(normalizeSession(content), null, 2)}\n`;
    },

    parse(raw) {
      try {
        return normalizeSession(JSON.parse(raw));
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        throw new ApplicationError("invalid_operation", "FreeCAD 会话描述不是合法 JSON", {});
      }
    },

    applyOperation({ operationType, payload, content }): OperationResult {
      if (operationType !== "session.update") {
        throw new ApplicationError("invalid_operation", `FreeCAD Harness 不支持操作 ${operationType}`, {
          operationType
        });
      }
      const old = normalizeSession(content);
      const input = (payload ?? {}) as Record<string, unknown>;
      const next: HarnessSession = {
        host: typeof input.host === "string" && input.host.trim() ? input.host.trim() : old.host,
        port: validPort(input.port) ? input.port : old.port
      };
      return {
        content: next,
        summary: `更新 FreeCAD 会话连接为 ${next.host}:${next.port}`,
        inverse: { operationType: "session.update", payload: old }
      };
    },

    summarizeSelection() {
      return "FreeCAD 会话没有可读取的选区";
    },

    summarizeContext({ content }: ContextRequest): ContextSummary {
      const { host, port } = normalizeSession(content);
      return { shape: `FreeCAD 会话（${host}:${port}）` };
    },

    exportResource({ format }) {
      throw new ApplicationError("invalid_operation", `FreeCAD Harness 不支持导出格式 ${format}`, { format });
    }
  };
}
