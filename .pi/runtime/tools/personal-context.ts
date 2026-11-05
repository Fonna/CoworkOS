import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PersonalContextChat } from "../../../dist/src/runtime/personal-context-chat.js";

export function registerPersonalContextTool(pi: ExtensionAPI, chat: PersonalContextChat) {
  pi.registerTool({
    name: "manage_personal_context",
    label: "Personal Context",
    description: chat.tool.description!,
    parameters: Type.Unsafe(chat.tool.parameters as Parameters<typeof Type.Unsafe>[0]),
    async execute(_callId, params, signal) {
      const result = await chat.tool.execute(params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    }
  });
}
