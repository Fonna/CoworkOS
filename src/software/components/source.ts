/** Public, immutable component releases are independent of the desktop app version. */
export const COMPONENT_REPOSITORY = "ignorejjj/Atria-Components";
export const COMPONENT_RELEASE_TAG = "components-v1";
export const DEFAULT_COMPONENT_RELEASE_ROOT = `https://github.com/${COMPONENT_REPOSITORY}/releases/download/${COMPONENT_RELEASE_TAG}`;
export const LEGACY_COMPONENT_REPOSITORY = "ignorejjj/Atria-Cowork";

export function componentReleaseRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.ATRIA_COMPONENTS_RELEASE_ROOT || DEFAULT_COMPONENT_RELEASE_ROOT;
}

/** Only an explicit old private release may request a GitHub credential. */
export function privateComponentSource(releaseRoot: string | undefined): boolean {
  if (!releaseRoot) return false;
  try {
    const source = new URL(releaseRoot);
    const prefix = `/${LEGACY_COMPONENT_REPOSITORY}/releases/download/`;
    const tag = source.pathname.slice(prefix.length);
    return (
      source.origin === "https://github.com" &&
      source.pathname.startsWith(prefix) &&
      Boolean(tag) &&
      !tag.includes("/") &&
      !source.username &&
      !source.password &&
      !source.search &&
      !source.hash
    );
  } catch {
    return false;
  }
}
