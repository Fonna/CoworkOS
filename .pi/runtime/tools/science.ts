import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createScienceTools, type ScienceToolOptions } from "../../../dist/src/tools/science-tools.js";

/** Only register for an opted-in Run; discovery never starts a Python process. */
export function registerScienceTools(
  pi: ExtensionAPI,
  options: ScienceToolOptions | undefined,
  workingDirectory: string
) {
  if (!options) return;
  const tools = createScienceTools(options, { workingDirectory });
  // Pi marks extension failures through tool_result hooks, not returned isError properties.
  pi.on("tool_result", (event) => {
    if (!tools.has(event.toolName)) return;
    const details = event.details;
    if (details && typeof details === "object" && "isError" in details && details.isError === true)
      return { isError: true };
  });
  for (const [name, tool] of tools) {
    pi.registerTool({
      name,
      label: name,
      description: tool.description!,
      parameters: Type.Unsafe(tool.parameters as Parameters<typeof Type.Unsafe>[0]),
      async execute(_id, params, signal) {
        const result = await tool.execute(params, signal);
        const isError = Boolean(
          result && typeof result === "object" && "isError" in result && result.isError === true
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
          details: result,
          ...(isError ? { isError: true } : {})
        };
      }
    });
  }
}
