import { createHash } from "node:crypto";

// Published CLIs need a shrinkwrap: consumer npm ignores a dependency's overrides.
// Keep the tested production topology and integrity, including overridden versions.
export function cliDependencies(source, lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
    throw new Error("CLI packaging requires a v2/v3 package-lock.json");
  const names = Object.keys(source.dependencies);
  // esbuild is transitive via Pi and must be installed for the consumer's OS/CPU.
  // Promote its tested version so even local archives resolve this edge exactly.
  if (lock.packages["node_modules/esbuild"]?.dev !== true && lock.packages["node_modules/esbuild"])
    names.push("esbuild");
  return Object.fromEntries(
    [...new Set(names)].map((name) => {
      const entry = lock.packages[`node_modules/${name}`];
      if (!entry?.version || entry.dev === true) throw new Error(`Missing production lock entry: ${name}`);
      return [name, entry.version];
    })
  );
}

export function cliShrinkwrap(manifest, lock) {
  cliDependencies(manifest, lock);
  return {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        license: manifest.license,
        engines: manifest.engines,
        bin: manifest.bin,
        dependencies: manifest.dependencies
      },
      ...Object.fromEntries(
        Object.entries(lock.packages).filter(([path, entry]) => path && entry.dev !== true)
      )
    }
  };
}

export function productionPackages(lock) {
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages)
    throw new Error("CLI packaging requires a v2/v3 package-lock.json");
  return Object.entries(lock.packages)
    .filter(([path, entry]) => path && entry.dev !== true)
    .filter(([path]) => !/^node_modules\/@esbuild\//.test(path))
    .map(([path, entry]) => {
      if (!/^node_modules\//.test(path) || path.split("/").includes("..") || entry.link)
        throw new Error(`Cannot bundle non-registry production dependency: ${path}`);
      if (entry.os || entry.cpu)
        throw new Error(`Platform dependency needs an explicit portable packaging strategy: ${path}`);
      return path;
    });
}

export function assertArchiveIntegrity(bytes, integrity) {
  const matches =
    typeof integrity === "string" &&
    integrity.split(/\s+/).some((expected) => {
      const match = /^(sha(?:1|256|384|512))-(.+)$/.exec(expected);
      return match && createHash(match[1]).update(bytes).digest("base64") === match[2];
    });
  if (!matches) throw new Error("Runtime archive does not match package-lock integrity");
}
