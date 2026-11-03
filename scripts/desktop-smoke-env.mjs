import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

/** Keep heavy runtime delivery outside host smoke, using only its new disposable data directory. */
export async function prepareDesktopSmokeComponents({ data, metadata }) {
  const nativeComponents = metadata.atriaBundledComponents === true;
  const mode = nativeComponents ? "full" : metadata.atriaAutoInstallComponents === true ? "light" : "base";
  if (!nativeComponents) {
    for (const id of ["cadquery", "blender"]) {
      const directory = join(data, "components", id);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "current.json"), JSON.stringify({ enabled: false }), {
        mode: 0o600,
        flag: "wx"
      });
    }
  }
  return { mode, nativeComponents, pptist: nativeComponents || metadata.atriaBundledPptist === true };
}

/** Keep the packaged smoke on its own data/model directories without changing the caller. */
export function desktopSmokeEnvironment({ data, source = process.env, blenderExecutable }) {
  const env = Object.fromEntries(
    Object.entries(source).filter(
      ([name]) =>
        !/^(?:ATRIA_|COWORK_|PI_|CSC_|APPLE_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|AWS_|BEDROCK_|MISTRAL_|GROQ_|XAI_|CEREBRAS_|OPENROUTER_|TOGETHER_|DEEPSEEK_|SERPER_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(
          name
        ) && !/_API_KEY$/.test(name)
    )
  );
  return {
    ...env,
    PATH: "/usr/bin:/bin",
    ATRIA_HOME: data,
    COWORK_DESKTOP_DATA: data,
    PI_CODING_AGENT_DIR: join(data, "pi"),
    COWORK_DISABLE_WATCH_SUPERVISOR: "1",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    ...(blenderExecutable ? { COWORK_BLENDER_EXECUTABLE: blenderExecutable } : {})
  };
}
