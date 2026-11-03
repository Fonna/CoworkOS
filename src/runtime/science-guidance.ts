import { join } from "node:path";
import type { ScienceToolOptions } from "../tools/science-tools.js";
import { atriaInstallRoot } from "../tools/protected-paths.js";

/** Keep scientific workflow metadata outside the automatically scanned project skills. */
export function scienceSkillRoots(
  options: ScienceToolOptions | undefined,
  harnessRoot = atriaInstallRoot()
): string[] {
  return options?.enabled === true ? [join(harnessRoot, ".pi", "runtime", "science-skills")] : [];
}

/** Interpreter selections are pinned metadata, never evidence that dependencies are installed. */
export function scienceEnvironmentGuidance(options: ScienceToolOptions | undefined): string {
  if (options?.enabled !== true) return "";
  return [
    "<scientific_environment>",
    `This Run's reviewed scientific catalog: ${JSON.stringify(options.catalogVersion)}.`,
    `Selected general Python executable: ${JSON.stringify(options.pythonExecutable ?? "python3")}.`,
    `Selected chemistry/RDKit Python executable: ${JSON.stringify(options.chemistryPythonExecutable ?? options.pythonExecutable ?? "python3")}.`,
    "These selections do not prove environment readiness. Use the selected executable explicitly for scientific scripts; an unrelated python command may use another environment.",
    "Use science_search, science_describe and science_run for matching reviewed calculations. science_run accepts named functions and JSON arguments, never arbitrary code or file paths. For other analysis, use existing file/command tools with the selected Python and the Task's existing permissions; persistent work uses jobs only when available. Record script inputs, dependencies, units and outputs. Do not change an environment incidentally to run an analysis.",
    "Load a scientific workflow skill only for a matching multi-step task. A simple conversion or single calculation does not require a skill.",
    "</scientific_environment>"
  ].join("\n");
}
