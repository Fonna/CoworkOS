import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createUserMemoryTool } from "../../../dist/src/runtime/user-memory-tools.js";

/** Only registered for Main; Subagents do not inherit access to the user profile. */
export function registerUserMemoryTool(
  pi: ExtensionAPI,
  options: Parameters<typeof createUserMemoryTool>[0]
) {
  const tool = createUserMemoryTool(options);
  pi.registerTool({
    name: "manage_user_memory",
    label: "User Memory",
    description: tool.description!,
    parameters: Type.Unsafe(tool.parameters as Parameters<typeof Type.Unsafe>[0]),
    async execute(_callId, params, signal) {
      const result = await tool.execute(params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
}
