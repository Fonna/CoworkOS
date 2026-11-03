import { LEGACY_COMPONENT_REPOSITORY, privateComponentSource } from "./source.js";

/** Release authentication is confined to this transport, never arbitrary component URLs. */
export const COMPONENT_TOKEN_ENV = "ATRIA_COMPONENTS_GITHUB_TOKEN";
export function validateComponentToken(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[\x21-\x7e]*$/.test(value))
    throw new Error("Component GitHub token must be a single-line ASCII value");
  return value;
}
export function takeComponentToken(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[COMPONENT_TOKEN_ENV] ?? "";
  delete env[COMPONENT_TOKEN_ENV];
  return validateComponentToken(value);
}
/** Bound release JSON and keep response text out of diagnostics. */
export async function componentJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Invalid component JSON response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      bytes += value.value.byteLength;
      if (bytes > 1_048_576) throw new Error();
      chunks.push(value.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid component JSON response; retry or verify release assets");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function componentTokenProvider(
  releaseRoot: string,
  env: NodeJS.ProcessEnv = process.env
): () => string {
  // Do not read a saved/inherited credential for the public distribution path.
  if (!privateComponentSource(releaseRoot)) {
    delete env[COMPONENT_TOKEN_ENV];
    return () => "";
  }
  const credential = takeComponentToken(env);
  return () => credential;
}
export function createComponentDownload({
  releaseRoot,
  fetcher = fetch,
  token = () => ""
}: {
  releaseRoot: string;
  fetcher?: typeof fetch;
  token?: () => string;
}) {
  const source = new URL(releaseRoot);
  const prefix = `/${LEGACY_COMPONENT_REPOSITORY}/releases/download/`;
  const github = privateComponentSource(releaseRoot);
  const failure = (status: number) =>
    new Error(
      github && [401, 403, 404].includes(status)
        ? `Component release access failed (HTTP ${status}); configure a GitHub token with Contents: read access to ignorejjj/Atria-Cowork in App components or ATRIA_COMPONENTS_GITHUB_TOKEN; verify the release tag and assets exist`
        : `Component release download failed (HTTP ${status}); check network and retry`
    );
  return async (file: string, signal: AbortSignal): Promise<Response> => {
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) throw new Error("Invalid component asset name");
    const credential = github ? validateComponentToken(token()) : "";
    try {
      if (!credential) {
        const result = await fetcher(`${releaseRoot}/${file}`, { signal });
        if (!result.ok) {
          await result.body?.cancel();
          throw failure(result.status);
        }
        return result;
      }
      const headers = {
        Authorization: `Bearer ${credential}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
      const api = `https://api.github.com/repos/${LEGACY_COMPONENT_REPOSITORY}/releases`;
      const metadata = await fetcher(
        `${api}/tags/${encodeURIComponent(decodeURIComponent(source.pathname.slice(prefix.length)))}`,
        {
          headers,
          signal,
          redirect: "manual"
        }
      );
      if (!metadata.ok) {
        await metadata.body?.cancel();
        throw failure(metadata.status);
      }
      const release: unknown = await componentJson(metadata);
      const assets =
        release && typeof release === "object" && "assets" in release ? release.assets : undefined;
      if (!Array.isArray(assets)) throw new Error("Invalid component release metadata");
      const asset = assets.find((value) => value && typeof value === "object" && value.name === file);
      if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) throw failure(404);
      const result = await fetcher(`${api}/assets/${asset.id}`, {
        headers: { ...headers, Accept: "application/octet-stream" },
        signal,
        redirect: "manual"
      });
      if (result.status === 302) {
        const location = result.headers.get("location");
        await result.body?.cancel();
        const destination = new URL(location || "");
        if (
          destination.protocol !== "https:" ||
          destination.username ||
          destination.password ||
          !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(
            destination.hostname
          )
        )
          throw new Error("Unsafe component asset redirect");
        // Signed asset URLs get no credential. Subsequent redirects are rejected.
        const download = await fetcher(destination, { signal, redirect: "manual" });
        if (!download.ok) {
          await download.body?.cancel();
          throw failure(download.status);
        }
        return download;
      }
      if (!result.ok) {
        await result.body?.cancel();
        throw failure(result.status);
      }
      return result;
    } catch (error) {
      if (signal.aborted) throw new Error("Component download cancelled or timed out");
      if (
        error instanceof Error &&
        /^(Component release |Invalid component |Unsafe component )/.test(error.message)
      )
        throw error;
      throw new Error("Component download unavailable; check network and GitHub access, then retry");
    }
  };
}
