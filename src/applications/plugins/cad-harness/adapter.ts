import {
  ApplicationError,
  type ContextRequest,
  type ContextSummary,
  type OperationResult,
  type WorkbenchRuntimeAdapter
} from "../../types.js";
import { buildCadControlMcpServerSpec } from "./mcp.js";
import { readCadWorkflowPrompt, resolveCadHarnessRoot, resolveCadSkillsRoot } from "./paths.js";

/**
 * The `cad-harness` application.
 *
 * A harness application owns no geometry: its purpose is to surface the tools of
 * the external cad_harness `cad-control` MCP server, so the agent can author and
 * render STEP-first parametric CAD (build123d). The resource is a tiny session
 * descriptor (`{ root }`, the cad_harness checkout) that exists only so the
 * platform has something to bind — binding it starts the MCP server, whose tools
 * become the application's tools. The modeling workflow lives in
 * `.pi/skills/cad-harness`.
 */

const APP = "cad-harness";
const KIND = "application/cad-session+json";

interface CadSession {
  root: string;
}

function defaultSession(): CadSession {
  return { root: resolveCadHarnessRoot() };
}

/** Normalize an arbitrary value into a session descriptor, filling absent fields. */
function normalizeSession(input: unknown): CadSession {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    root: typeof value.root === "string" && value.root.trim() ? value.root.trim() : resolveCadHarnessRoot()
  };
}

export function createCadHarnessAdapter(): WorkbenchRuntimeAdapter {
  return {
    definition: {
      appType: APP,
      displayName: "CAD Harness",
      catalogVisibility: "compatibility",
      version: "1",
      resourceKinds: [KIND],
      fileExtensions: { [KIND]: ".cad-session.json" },
      capabilities: ["view", "edit", "agent-commands"],
      operationSchemas: {
        "session.update": {
          description: "更新 cad_harness 会话路径",
          required: [],
          optional: ["root"]
        }
      },
      exportFormats: [],
      creationHint:
        "CAD Harness 通过 cad_harness 的 cad-control MCP 驱动 STEP-first 参数化建模；渲染由 cad-viewer（端口 3245）提供，点「打开」拉起。",
      mcpServer: buildCadControlMcpServerSpec(),
      skillRoots: [".pi/skills/cad-harness", resolveCadSkillsRoot()],
      systemPrompt: readCadWorkflowPrompt() || undefined
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
        throw new ApplicationError("invalid_operation", "CAD 会话描述不是合法 JSON", {});
      }
    },

    applyOperation({ operationType, payload, content }): OperationResult {
      if (operationType !== "session.update") {
        throw new ApplicationError("invalid_operation", `CAD Harness 不支持操作 ${operationType}`, {
          operationType
        });
      }
      const old = normalizeSession(content);
      const input = (payload ?? {}) as Record<string, unknown>;
      const next: CadSession = {
        root: typeof input.root === "string" && input.root.trim() ? input.root.trim() : old.root
      };
      return {
        content: next,
        summary: `更新 CAD 会话路径为 ${next.root}`,
        inverse: { operationType: "session.update", payload: old }
      };
    },

    summarizeSelection() {
      return "CAD 会话没有可读取的选区";
    },

    summarizeContext({ content }: ContextRequest): ContextSummary {
      const { root } = normalizeSession(content);
      return { shape: `CAD 会话（${root}）` };
    },

    exportResource({ format }) {
      throw new ApplicationError("invalid_operation", `CAD Harness 不支持导出格式 ${format}`, { format });
    }
  };
}
