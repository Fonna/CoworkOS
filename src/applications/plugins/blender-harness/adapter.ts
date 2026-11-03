import {
  ApplicationError,
  type ContextRequest,
  type ContextSummary,
  type OperationResult,
  type WorkbenchRuntimeAdapter
} from "../../types.js";
import { buildBlenderMcpServerSpec } from "./mcp.js";
import {
  readBlenderWorkflowPrompt,
  resolveBlenderHost,
  resolveBlenderPort,
  resolveBlenderSkillsRoot
} from "./paths.js";

/**
 * The `blender-harness` application.
 *
 * A *separate* integration from the native `blender` application: this one owns
 * no geometry and exists only to surface the tools of the official Blender MCP
 * server, so the agent can drive a *running* Blender. The resource is a tiny
 * session descriptor (`{ host, port }`) that exists only so the platform has
 * something to bind: binding it starts the MCP server, and the server's tools
 * become the application's tools.
 *
 * No in-process `agentTools` are declared — the tools come from the MCP server,
 * discovered by the application bridge once the resource is bound. The modeling
 * workflow itself lives in `.pi/skills/blender-harness`.
 */

const APP = "blender-harness";
const KIND = "application/blender-session+json";

interface HarnessSession {
  host: string;
  port: number;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value < 65536;
}

function defaultSession(): HarnessSession {
  return { host: resolveBlenderHost(), port: resolveBlenderPort() };
}

/** Normalize an arbitrary value into a session descriptor, filling absent/illegal fields. */
function normalizeSession(input: unknown): HarnessSession {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    host: typeof value.host === "string" && value.host.trim() ? value.host.trim() : resolveBlenderHost(),
    port: validPort(value.port) ? value.port : resolveBlenderPort()
  };
}

export function createBlenderHarnessAdapter(): WorkbenchRuntimeAdapter {
  return {
    definition: {
      appType: APP,
      displayName: "Blender Harness",
      catalogVisibility: "compatibility",
      version: "1",
      resourceKinds: [KIND],
      fileExtensions: { [KIND]: ".blender-session.json" },
      capabilities: ["view", "edit", "agent-commands"],
      operationSchemas: {
        "session.update": {
          description: "更新 Blender 会话连接目标",
          required: [],
          optional: ["host", "port"]
        }
      },
      exportFormats: [],
      creationHint:
        "Blender Harness 通过官方 Blender MCP 驱动正在运行的 Blender。先启动 Blender 并启用 MCP addon（默认 TCP 端口 9876），再绑定本会话资源。",
      mcpServer: buildBlenderMcpServerSpec(),
      skillRoots: [".pi/skills/blender-harness", resolveBlenderSkillsRoot()],
      systemPrompt: readBlenderWorkflowPrompt() || undefined
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
        throw new ApplicationError("invalid_operation", "Blender 会话描述不是合法 JSON", {});
      }
    },

    applyOperation({ operationType, payload, content }): OperationResult {
      if (operationType !== "session.update") {
        throw new ApplicationError("invalid_operation", `Blender Harness 不支持操作 ${operationType}`, {
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
        summary: `更新 Blender 会话连接为 ${next.host}:${next.port}`,
        inverse: { operationType: "session.update", payload: old }
      };
    },

    summarizeSelection() {
      return "Blender 会话没有可读取的选区";
    },

    summarizeContext({ content }: ContextRequest): ContextSummary {
      const { host, port } = normalizeSession(content);
      return { shape: `Blender 会话（${host}:${port}）` };
    },

    exportResource({ format }) {
      throw new ApplicationError("invalid_operation", `Blender Harness 不支持导出格式 ${format}`, { format });
    }
  };
}
