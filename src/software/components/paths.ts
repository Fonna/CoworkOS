import { existsSync, readFileSync, realpathSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
export const componentIds = ["cadquery", "blender", "pptist"] as const;
export type ComponentId = (typeof componentIds)[number];
const applicationRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const packageMetadata = (() => {
  try {
    return JSON.parse(readFileSync(join(applicationRoot, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
})();
const bundledComponents = packageMetadata.atriaBundledComponents === true;
/** Source checkouts and CLI builds never prepare components merely by starting a server. */
export function autoInstallComponentsEnabled(metadata: Record<string, unknown> = packageMetadata): boolean {
  return metadata.atriaAutoInstallComponents === true && metadata.atriaBundledComponents === false;
}
/** Full desktop releases upgrade their immutable components together with the host. */
export function packagedComponentDirectory(id: ComponentId): string | undefined {
  if (id === "pptist")
    return bundledComponents || packageMetadata.atriaBundledPptist === true
      ? join(applicationRoot, "web/assets/pptist/generated")
      : undefined;
  if (!bundledComponents) return undefined;
  return resolve(applicationRoot, "..", id);
}
/** Source/CLI installs retain managed versions; a full desktop package uses its bundled version. */
export function selectedComponentDirectory(id: ComponentId): string | undefined {
  return packagedComponentDirectory(id) || componentDirectory(id);
}
export function componentHome(): string {
  return resolve(
    process.env.ATRIA_COMPONENTS_HOME ||
      join(process.env.ATRIA_HOME || join(homedir(), ".atria"), "components")
  );
}
export function componentDirectory(id: ComponentId): string | undefined {
  const base = join(componentHome(), id);
  try {
    if (lstatSync(base).isSymbolicLink() || lstatSync(join(base, "versions")).isSymbolicLink())
      return undefined;
    const state = JSON.parse(readFileSync(join(base, "current.json"), "utf8"));
    if (
      state.enabled === false ||
      state.apiVersion !== 1 ||
      typeof state.version !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(state.version) ||
      (id !== "pptist" && state.platform !== `${process.platform}-${process.arch}`)
    )
      return undefined;
    const directory = join(base, "versions", state.version);
    if (!existsSync(directory)) return undefined;
    const real = realpathSync(directory),
      boundary = realpathSync(base) + sep;
    return real.startsWith(boundary) ? real : undefined;
  } catch {
    return undefined;
  }
}
export function componentDisabled(id: ComponentId): boolean {
  try {
    return JSON.parse(readFileSync(join(componentHome(), id, "current.json"), "utf8")).enabled === false;
  } catch {
    return false;
  }
}
