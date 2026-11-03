import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, symlink, writeFile, rename, rm, access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

const brandingPolicyRevision = 3;
const changelog = `# CoworkOS updates

Use /changelog for CoworkOS's update information and coworkos update --check to check for an update.
The Pi engine's original changelog remains in its installed package.
`;

/** Seed a CLI-only display preference while preserving explicit user/project settings. */
export async function ensureCliStartupSettings({ agentDir, projectDirectory }) {
  const { SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const settings = SettingsManager.create(projectDirectory, agentDir);
  const errors = settings.drainErrors();
  if (errors.length) throw new Error("CoworkOS CLI 的界面设置无法读取，已保留原文件。");
  if (
    settings.getGlobalSettings().quietStartup !== undefined ||
    settings.getProjectSettings().quietStartup !== undefined
  )
    return false;
  settings.setQuietStartup(true);
  await settings.flush();
  if (settings.drainErrors().length) throw new Error("CoworkOS CLI 的界面设置保存失败，请检查目录权限。");
  return true;
}

/** Public Pi package-directory adapter; upstream code and assets remain unchanged. */
export async function ensureCliBranding({ agentDir, piPackageDir, version }) {
  const profile = resolve(agentDir);
  const source = resolve(piPackageDir);
  const original = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  if (original.name !== "@earendil-works/pi-coding-agent")
    throw new Error("CoworkOS CLI 的 Pi 运行时目录无效，请运行 coworkos doctor。");
  const appVersion = version || original.version;
  const resources = {
    "README.md": await readFile(join(source, "README.md"), "utf8"),
    "CHANGELOG.md": changelog
  };
  const metadata = {
    ...original,
    version: appVersion,
    piConfig: { ...original.piConfig, name: "coworkos", configDir: ".pi" },
    atriaRuntimeAdapter: {
      upstreamVersion: original.version,
      policyRevision: brandingPolicyRevision,
      resourceSha256: Object.fromEntries(
        Object.entries(resources).map(([name, text]) => [
          name,
          createHash("sha256").update(text).digest("hex")
        ])
      )
    }
  };
  const key = createHash("sha256").update(JSON.stringify({ source, metadata })).digest("hex").slice(0, 20);
  const parent = join(profile, ".atria-runtime");
  const directory = join(parent, `pi-${key}`);
  const env = {
    PI_PACKAGE_DIR: directory,
    COWORKOS_CODING_AGENT_DIR: profile,
    ATRIA_CODING_AGENT_DIR: profile
  };
  const validate = async () => {
    try {
      const installed = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (JSON.stringify(installed) !== JSON.stringify(metadata)) throw new Error("metadata mismatch");
      for (const [name, expected] of Object.entries(resources))
        if ((await readFile(join(directory, name), "utf8")) !== expected)
          throw new Error("resource mismatch");
      for (const name of ["dist", "docs", "examples"])
        if ((await realpath(join(directory, name))) !== (await realpath(join(source, name))))
          throw new Error("resource target mismatch");
    } catch (cause) {
      throw new Error("CoworkOS CLI 的界面资源校验失败，原缓存已保留；请重新安装 CLI。", { cause });
    }
  };
  try {
    await access(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Only a missing immutable directory is publishable. A corrupt cache is
    // retained and rejected, never repaired in place underneath another session.
    await mkdir(parent, { recursive: true, mode: 0o700 });
  }
  if (
    await access(directory).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    )
  ) {
    await validate();
    return env;
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const candidate = join(parent, `.pi-${key}-${randomUUID()}`);
  await mkdir(candidate, { mode: 0o700 });
  try {
    // Immutable, versioned overlays keep concurrent or older sessions usable.
    // Windows directory junctions avoid requiring symlink privileges.
    for (const name of ["dist", "docs", "examples"]) {
      await symlink(
        join(source, name),
        join(candidate, name),
        process.platform === "win32" ? "junction" : "dir"
      );
    }
    for (const [name, text] of Object.entries(resources))
      await writeFile(join(candidate, name), text, { mode: 0o600 });
    await writeFile(join(candidate, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
      mode: 0o600
    });
    try {
      await rename(candidate, directory);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      // Another startup published the identical complete overlay first.
      await validate();
    }
    await validate();
    return env;
  } finally {
    await rm(candidate, { recursive: true, force: true });
  }
}
