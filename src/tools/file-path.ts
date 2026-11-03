import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

/** Resolve existing ancestors, including a not-yet-created file's parent. */
export async function resolveFileTarget(path: string): Promise<string> {
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
      continue;
    }
    // A dangling or cyclic link is an error, rather than a missing directory
    // through which the tool may create a file.
    return resolve(await realpath(ancestor), ...missing);
  }
}

/** A declared protected path also protects a linked target that does not exist yet. */
export async function resolveProtectedTarget(path: string): Promise<string> {
  const absolute = resolve(path);
  let target = parse(absolute).root;
  let pending = pathComponents(absolute.slice(target.length));
  let links = 0;
  while (pending.length) {
    const component = pending.shift()!;
    if (component === ".") continue;
    if (component === "..") {
      target = dirname(target);
      continue;
    }
    const candidate = join(target, component);
    let info;
    try {
      info = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      target = candidate;
      continue;
    }
    if (!info.isSymbolicLink()) {
      target = candidate;
      continue;
    }
    if (++links > 40) throw new Error(`too many symbolic links in protected path: ${path}`);
    const link = await readlink(candidate);
    if (isAbsolute(link)) {
      target = parse(link).root;
      pending = [...pathComponents(link.slice(target.length)), ...pending];
    } else {
      // Keep '..' until preceding links have resolved. Lexically normalizing
      // a link such as 'alias/../score' would protect the wrong future folder.
      pending = [...pathComponents(link), ...pending];
    }
  }
  return resolveFileTarget(target);
}

function pathComponents(path: string): string[] {
  return path.split(sep === "\\" ? /[\\/]+/ : /\/+/).filter(Boolean);
}

export function containsFilePath(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
