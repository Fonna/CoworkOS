import type { CoworkConfig } from "./config.js";
import { modelConnections } from "./model-connections.js";
import { normalizeModelApi, normalizeReasoningEffort, normalizeThinkingFormat } from "./runtime-settings.js";
import type { VisionModelConfig } from "../tools/vision-model.js";

/** Credentials remain in the existing connection registry or trusted child environment. */
export function visionModelConfig(
  config: CoworkConfig,
  env: NodeJS.ProcessEnv = process.env
): VisionModelConfig | undefined {
  if (
    [env.COWORK_VISION_API_BASE, env.COWORK_VISION_API_KEY, env.COWORK_VISION_MODEL].some(
      (v) => v !== undefined
    )
  ) {
    const baseUrl = env.COWORK_VISION_API_BASE;
    const apiKey = env.COWORK_VISION_API_KEY;
    const model = env.COWORK_VISION_MODEL;
    if (!baseUrl && !apiKey && !model) return undefined;
    if (!baseUrl?.trim() || !apiKey?.trim() || !model?.trim())
      throw new Error("Vision environment requires API base, key and model");
    const tokens = env.COWORK_VISION_MAX_TOKENS === undefined ? 8192 : Number(env.COWORK_VISION_MAX_TOKENS);
    if (!Number.isInteger(tokens) || tokens < 1 || tokens > 65536)
      throw new Error("Vision output limit must be 1–65536");
    const reasoning = env.COWORK_VISION_SUPPORTS_REASONING_EFFORT ?? "0";
    if (!/^(0|1|false|true)$/i.test(reasoning))
      throw new Error("Vision reasoning capability must be boolean");
    return {
      baseUrl,
      apiKey,
      model,
      api: normalizeModelApi(env.COWORK_VISION_MODEL_API),
      thinkingFormat: normalizeThinkingFormat(env.COWORK_VISION_THINKING_FORMAT),
      reasoningEffort: normalizeReasoningEffort(env.COWORK_VISION_REASONING_EFFORT ?? "off"),
      supportsReasoningEffort: /^(1|true)$/i.test(reasoning),
      maxTokens: tokens
    };
  }
  const registry = modelConnections(config);
  const profile = registry.profiles.find((p) => p.id === registry.visionId);
  if (!profile) return undefined;
  if (!profile.apiKey) return undefined; // Encrypted desktop keys are supplied by the trusted host.
  return { ...profile, apiKey: profile.apiKey };
}

export function visionModelEnv(
  config: CoworkConfig,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const vision = visionModelConfig(config, env);
  if (!vision) return {};
  return {
    COWORK_VISION_API_BASE: vision.baseUrl,
    COWORK_VISION_API_KEY: vision.apiKey,
    COWORK_VISION_MODEL: vision.model,
    COWORK_VISION_MODEL_API: vision.api ?? "openai-completions",
    COWORK_VISION_THINKING_FORMAT: vision.thinkingFormat ?? "auto",
    COWORK_VISION_REASONING_EFFORT: vision.reasoningEffort ?? "off",
    COWORK_VISION_SUPPORTS_REASONING_EFFORT: vision.supportsReasoningEffort ? "1" : "0",
    COWORK_VISION_MAX_TOKENS: String(vision.maxTokens ?? vision.subagentMaxTokens ?? 8192)
  };
}
