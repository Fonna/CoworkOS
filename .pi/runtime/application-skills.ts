import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import {
  applicationSkillScope,
  discoverSkills,
  type ApplicationSkillScope
} from "../../dist/src/runtime/skill-registry.js";

/** SDK selection is authoritative once available, even when the list is empty.
 * Base roots are only a compatibility fallback for older extension callers. */
export function mainApplicationSkillScope(
  baseRoots: readonly string[],
  application: { appType: string; skillRoots: string[] } | undefined,
  harnessRoot: string,
  sdkSkills: readonly Skill[] | undefined
): ApplicationSkillScope {
  const generalRoots =
    sdkSkills === undefined
      ? baseRoots
      : sdkSkills.filter((skill) => !skill.disableModelInvocation).map((skill) => skill.filePath);
  return applicationSkillScope(generalRoots, application, harnessRoot);
}

/** Use the same scoped discovery for Pi's catalog and load_skill. Keep extra
 * SDK skill paths (user packages / explicit --skill), including their flags. */
export async function mainApplicationSkills(
  scope: ApplicationSkillScope,
  sdkSkills: readonly Skill[]
): Promise<Skill[]> {
  const discovered = await discoverSkills(scope.skillRoots, { applications: scope.skillApplications });
  const original = new Map(sdkSkills.map((skill) => [skill.filePath, skill]));
  return discovered.map(
    (skill) =>
      original.get(skill.path) ?? {
        name: skill.name,
        description: skill.description,
        filePath: skill.path,
        baseDir: skill.directory,
        sourceInfo: { path: skill.path, source: "atria", scope: "project", origin: "top-level" },
        disableModelInvocation: false
      }
  );
}

export function mainApplicationSkillsSection(skills: Skill[]): string {
  return `<skills>\n${formatSkillsForPrompt(skills, "read").trim()}\n</skills>`;
}
