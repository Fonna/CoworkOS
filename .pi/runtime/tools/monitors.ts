import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WatchManagement, WATCH_TEMPLATES } from "../../../dist/src/runtime/watch-management.js";
import type { CoworkToolContext } from "../extension.ts";
import type { RuntimeToolResult } from "../helpers.ts";

/** monitors tools depend only on explicit runtime ports. */
export function registerMonitorsTools(pi: ExtensionAPI, context: CoworkToolContext) {
  pi.registerTool({
    name: "activate_virtual_agent",
    label: "Activate Virtual Agent",
    description:
      "Register a reviewed Virtual Agent package as a persistent monitor on this Task. The package is validated, its probe runs once to establish a cursor baseline, and only then is it activated. This is an explicit acceptance action: a file appearing in the workspace, or a Subagent finishing, never registers anything.",
    promptSnippet: "Register a reviewed Virtual Agent package as a persistent monitor",
    promptGuidelines: [
      "Read the package before calling this. You are accepting what it will do unattended, on this Task's budget, for as long as it stays active.",
      "task states what this monitor is responsible for and what is worth reporting; it becomes the monitor's standing brief. Do not paste the package README into it.",
      "cadenceSeconds is your tradeoff between cost and latency. A source that changes daily does not need an hourly check.",
      "If the probe fails the package is registered as a draft and does not poll. Fix the rule with the file tools and call this again; do not activate around a failure.",
      "Use send_subagent_message with the returned monitorId to correct a running monitor's scope, and cancel_subagent to pause it."
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Package directory containing manifest.json, relative to this Task's workspace."
      }),
      task: Type.String({
        description: "What this monitor is responsible for and what counts as worth reporting."
      }),
      cadenceSeconds: Type.Number({ description: "How often the probe runs. Minimum 60." }),
      programId: Type.Optional(
        Type.String({ description: "Attach to an existing Watch Program; omit to create one." })
      ),
      objective: Type.Optional(
        Type.String({ description: "Objective for the Watch Program when creating a new one." })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const result = await new WatchManagement(context.workspaceRoot, context.harnessRoot).activate(
        context.taskId,
        context.mainRunId,
        params
      );
      context.updateRuntime({
        runtimeLastEvent: { type: "virtual_agent_activated", summary: JSON.stringify(result) }
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
        ...(!result.activated ? { isError: true } : {})
      };
    }
  });
  pi.registerTool({
    name: "create_watcher",
    label: "Create Watcher",
    description:
      "Configure and activate a tested watcher template. Pass programId to attach sources to an existing long-term goal on this Task, without creating another conversation. Otherwise use scope=session for this Task or background for an independent persistent conversation. Use this tool directly for built-in templates; no package authoring or reading template source is needed. Probe errors leave a visible draft. No-change checks do not run a model.",
    parameters: Type.Object({
      template: Type.Union(WATCH_TEMPLATES.map((name) => Type.Literal(name))),
      task: Type.String(),
      source: Type.Optional(Type.String()),
      config: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            'Template settings: feed-keyword={sourceFormat:"github-atom"|"github-releases"|"items"|"hn-search",keywords:["Claude Code"]}; metric-threshold={metric:"loss",unit:"ratio",threshold:2,direction:"above"|"below",consecutiveSamples:2}; resource-version={stableChecks:2}; job-lifecycle={quietAfterMs:600000}; entity-state={entityId:"id",targetStates:["ready"]}; timer={startAt:"ISO timestamp",intervalMs:3600000|null}. Source is a local absolute file path except feed/entity HTTP URLs; timer has no source. The runtime tests and probes the built-in template.'
        })
      ),
      cadenceSeconds: Type.Number(),
      scope: Type.Optional(Type.Union([Type.Literal("session"), Type.Literal("background")])),
      eventMode: Type.Optional(Type.Union([Type.Literal("direct"), Type.Literal("analyze")])),
      maxModelRunsPerDay: Type.Optional(Type.Number()),
      maxWakeRequestsPerDay: Type.Optional(Type.Number()),
      expiresAt: Type.Optional(Type.String()),
      programId: Type.Optional(
        Type.String({
          description:
            "Existing goal programId on this Task; all its sources share one goal, memory and Main."
        })
      )
    }),
    async execute(_toolCallId, params): Promise<RuntimeToolResult> {
      const result = await new WatchManagement(context.workspaceRoot, context.harnessRoot).create(
        context.taskId,
        context.mainRunId,
        params
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
        ...(!result.activated ? { isError: true } : {})
      };
    }
  });
}
