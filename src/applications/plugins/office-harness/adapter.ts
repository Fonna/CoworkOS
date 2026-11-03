import {
  ApplicationError,
  type ContextRequest,
  type ContextSummary,
  type OperationResult,
  type WorkbenchRuntimeAdapter
} from "../../types.js";
import { buildOfficeHarnessMcpServerSpec } from "./mcp.js";
import {
  readOfficeWorkflowPrompt,
  resolveOfficeHarnessProfile,
  resolveOfficeHarnessSkillsRoot
} from "./paths.js";

/**
 * The `office-harness` application.
 *
 * A harness application owns no document model: its purpose is to surface the
 * tools of the external `officeharness` MCP server, so the agent can edit a
 * browser-hosted Impress (WASM PPTX) deck that the user sees in the embedded
 * native panel on the right. The resource is a tiny session descriptor
 * (`{ profile }`, the shared OfficeHarness profile dir) that exists only so the
 * platform has something to bind — binding it starts the MCP server, whose
 * `ppt_*` tools become the application's tools. The editing workflow lives in
 * `.pi/skills/office-harness` (fallback) and the plugin's `skills/ppt`.
 */

const APP = "office-harness";
const KIND = "application/office-session+json";

interface OfficeSession {
  profile: string;
}

function defaultSession(): OfficeSession {
  return { profile: resolveOfficeHarnessProfile() };
}

/** Normalize an arbitrary value into a session descriptor, filling absent fields. */
function normalizeSession(input: unknown): OfficeSession {
  const value = (input ?? {}) as Record<string, unknown>;
  return {
    profile:
      typeof value.profile === "string" && value.profile.trim()
        ? value.profile.trim()
        : resolveOfficeHarnessProfile()
  };
}

export function createOfficeHarnessAdapter(): WorkbenchRuntimeAdapter {
  return {
    definition: {
      appType: APP,
      displayName: "OfficeHarness",
      catalogVisibility: "compatibility",
      version: "1",
      resourceKinds: [KIND],
      fileExtensions: { [KIND]: ".office-session.json" },
      capabilities: ["view", "edit", "agent-commands"],
      operationSchemas: {
        "session.update": {
          description: "更新 OfficeHarness 工作区 profile 路径",
          required: [],
          optional: ["profile"]
        }
      },
      exportFormats: [],
      creationHint:
        "OfficeHarness 通过 officeharness MCP 驱动浏览器内嵌的 Impress 工作区（WASM PPTX 编辑器），右侧原生面板承载同一份文稿。",
      mcpServer: buildOfficeHarnessMcpServerSpec(),
      skillRoots: [".pi/skills/office-harness", resolveOfficeHarnessSkillsRoot()],
      systemPrompt: readOfficeWorkflowPrompt() || undefined
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
        throw new ApplicationError("invalid_operation", "Office 会话描述不是合法 JSON", {});
      }
    },

    applyOperation({ operationType, payload, content }): OperationResult {
      if (operationType !== "session.update") {
        throw new ApplicationError("invalid_operation", `OfficeHarness 不支持操作 ${operationType}`, {
          operationType
        });
      }
      const old = normalizeSession(content);
      const input = (payload ?? {}) as Record<string, unknown>;
      const next: OfficeSession = {
        profile:
          typeof input.profile === "string" && input.profile.trim() ? input.profile.trim() : old.profile
      };
      return {
        content: next,
        summary: `更新 Office 工作区 profile 为 ${next.profile}`,
        inverse: { operationType: "session.update", payload: old }
      };
    },

    summarizeSelection() {
      return "Office 会话没有可读取的选区";
    },

    summarizeContext({ content }: ContextRequest): ContextSummary {
      const { profile } = normalizeSession(content);
      return { shape: `Office 工作区（${profile}）` };
    },

    exportResource({ format }) {
      throw new ApplicationError("invalid_operation", `OfficeHarness 不支持导出格式 ${format}`, { format });
    }
  };
}
