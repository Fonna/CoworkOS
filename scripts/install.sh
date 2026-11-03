#!/usr/bin/env bash
# Install the published CLI. Requires Node.js >=22.19.0, npm and curl.
# Overrides: ATRIA_INSTALL_PREFIX, ATRIA_INSTALL_FEED_URL,
# ATRIA_INSTALL_RELEASE_BASE_URL, ATRIA_INSTALL_PROFILE (one shell profile);
# ATRIA_INSTALL_SKIP_PATH=1 skips shell setup.
set -euo pipefail

fail() { printf 'CoworkOS install: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)/$(uname -m)" in
  Darwin/arm64|Darwin/x86_64|Linux/aarch64|Linux/arm64|Linux/x86_64) ;;
  *) fail 'Supported platforms: macOS / Linux on x64 or arm64.' ;;
esac
for command in node npm curl; do
  command -v "$command" >/dev/null 2>&1 || fail "Install Node.js >=22.19.0 (including npm) and curl first: https://nodejs.org/en/download"
done
node -e 'const [a,b,c] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && (b > 19 || (b === 19 && c >= 0))) ? 0 : 1)' \
  || fail 'Node.js >=22.19.0 is required: https://nodejs.org/en/download'

install_prefix="${ATRIA_INSTALL_PREFIX:-$HOME/.local}"
feed_url="${ATRIA_INSTALL_FEED_URL:-https://raw.githubusercontent.com/ignorejjj/Atria-Releases/main/updates/coworkos-latest.json}"
feed_fallback=""
if [ -z "${ATRIA_INSTALL_FEED_URL:-}" ]; then
  feed_fallback="https://raw.githubusercontent.com/ignorejjj/Atria-Releases/main/updates/latest.json"
fi
release_base="${ATRIA_INSTALL_RELEASE_BASE_URL:-https://github.com/ignorejjj/Atria-Releases/releases/download}"
node - "$install_prefix" "$feed_url" "$release_base" <<'NODE'
const { isAbsolute } = require("node:path");
const [prefix, ...urls] = process.argv.slice(2);
if (!isAbsolute(prefix) || /[\x00-\x1f\x7f]/.test(prefix)) throw new Error("ATRIA_INSTALL_PREFIX must be an absolute path");
const profile = process.env.ATRIA_INSTALL_PROFILE;
if (profile && (!isAbsolute(profile) || /[\x00-\x1f\x7f]/.test(profile))) throw new Error("ATRIA_INSTALL_PROFILE must be an absolute path");
for (const value of urls) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash || /[\r\n]/.test(value))
    throw new Error("Installer URLs must use HTTPS (HTTP is allowed only for localhost tests)");
}
NODE

temporary="$(mktemp -d "${TMPDIR:-/tmp}/atria-install.XXXXXXXX")"
trap 'rm -rf "$temporary"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
download() {
  local status
  if status="$(curl --disable --fail --silent --show-error --location --proto '=https,http' \
    --proto-redir '=https' --connect-timeout 15 --max-time 180 --retry 2 \
    --max-filesize "$3" --write-out '%{http_code}' --output "$2" "$1" </dev/null)"; then
    return
  fi
  if [ "$status" = 404 ] && [ -n "${4:-}" ]; then
    download "$4" "$2" "$3"
  else
    fail 'Download failed; the CLI was not installed.'
  fi
}

printf 'Checking the published CoworkOS CLI release…\n'
download "$feed_url" "$temporary/feed.json" 32768 "$feed_fallback"
node - "$temporary/feed.json" "$release_base" > "$temporary/release" <<'NODE'
const { readFileSync, statSync } = require("node:fs");
const [file, base] = process.argv.slice(2);
const invalid = () => { throw new Error("Invalid CoworkOS public release feed; installation stopped"); };
if (statSync(file).size > 32768) invalid();
const feed = JSON.parse(readFileSync(file, "utf8"));
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*)(?:\.(?:0|[1-9]\d*|[\dA-Za-z-]*[A-Za-z-][\dA-Za-z-]*))*))?(?:\+[\dA-Za-z-]+(?:\.[\dA-Za-z-]+)*)?$/;
const repository = "ignorejjj/Atria-Releases";
const keys = ["schemaVersion", "repository", "version", "publishedAt", "releaseUrl", "artifacts", "feedUrl"];
if (!feed || Array.isArray(feed) || Object.keys(feed).some(key => !keys.includes(key)) ||
    feed.schemaVersion !== 1 || feed.repository !== repository || typeof feed.version !== "string" ||
    feed.version.length > 128 || !versionPattern.test(feed.version) ||
    typeof feed.publishedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(feed.publishedAt) ||
    !Number.isFinite(Date.parse(feed.publishedAt)) || new Date(feed.publishedAt).toISOString() !== feed.publishedAt ||
    feed.releaseUrl !== `https://github.com/${repository}/releases/tag/${encodeURIComponent(`v${feed.version}`)}` ||
    !Array.isArray(feed.artifacts) || feed.artifacts.length < 4 || feed.artifacts.length > 11) invalid();
const version = feed.version;
const legacy = feed.artifacts.some(item => item?.name === `atria-cowork-cli-${version}.tgz`);
const brand = legacy ? "Atria" : "CoworkOS";
const cli = legacy ? "atria-cowork-cli" : "coworkos-cli";
const names = [`${brand}-${version}-mac-arm64.dmg`, `${cli}-${version}.tgz`,
  `${brand}-${version}-mac-arm64.signing.json`, `atria-release-${version}.json`].flatMap(name => [name, `${name}.sha256`]);
const canonicalBase = `https://github.com/${repository}/releases/download/${encodeURIComponent(`v${version}`)}`;
const required = names.slice(0, 4);
if (feed.feedUrl !== undefined) {
  if (feed.feedUrl !== `${canonicalBase}/atria-update-mac-arm64.json`) invalid();
  names.push(`${brand}-${version}-mac-arm64.zip`, `${brand}-${version}-mac-arm64.zip.sha256`, "atria-update-mac-arm64.json");
  required.push(...names.slice(-3));
}
const seen = new Set();
for (const item of feed.artifacts) {
  if (!item || Array.isArray(item) || Object.keys(item).length !== 4 ||
      Object.keys(item).some(key => !["name", "size", "sha256", "url"].includes(key)) ||
      !names.includes(item.name) || seen.has(item.name) || !Number.isSafeInteger(item.size) ||
      item.size <= 0 || item.size > 2147483647 || !/^[a-f0-9]{64}$/.test(item.sha256) ||
      item.url !== `${canonicalBase}/${encodeURIComponent(item.name)}`) invalid();
  seen.add(item.name);
}
if (required.some(name => !seen.has(name))) invalid();
const archive = feed.artifacts.find(item => item.name === `${cli}-${version}.tgz`);
const checksum = feed.artifacts.find(item => item.name === `${archive.name}.sha256`);
if (checksum.size > 4096) invalid();
const endpoint = `${base.replace(/\/$/, "")}/${encodeURIComponent(`v${version}`)}`;
console.log([version, archive.name, `${endpoint}/${encodeURIComponent(archive.name)}`,
  `${endpoint}/${encodeURIComponent(checksum.name)}`, archive.size, archive.sha256, checksum.size, checksum.sha256].join("\n"));
NODE
{
  IFS= read -r version
  IFS= read -r archive_name
  IFS= read -r archive_url
  IFS= read -r checksum_url
  IFS= read -r archive_size
  IFS= read -r archive_sha
  IFS= read -r checksum_size
  IFS= read -r checksum_sha
} < "$temporary/release"

printf 'Downloading CoworkOS %s…\n' "$version"
download "$archive_url" "$temporary/$archive_name" "$archive_size"
download "$checksum_url" "$temporary/$archive_name.sha256" "$checksum_size"
node - "$temporary/$archive_name" "$archive_name" "$archive_size" "$archive_sha" "$checksum_size" "$checksum_sha" <<'NODE'
const { readFileSync, statSync, createReadStream } = require("node:fs");
const { createHash } = require("node:crypto");
const [file, name, size, sha, checksumSize, checksumSha] = process.argv.slice(2);
async function verify(path, expectedSize, expectedSha) {
  if (statSync(path).size !== Number(expectedSize)) throw new Error("Release size mismatch; installation stopped");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== expectedSha) throw new Error("Release SHA-256 mismatch; installation stopped");
}
(async () => {
  await verify(file, size, sha);
  await verify(`${file}.sha256`, checksumSize, checksumSha);
  if (readFileSync(`${file}.sha256`, "utf8").trim() !== `${sha}  ${name}`)
    throw new Error("Release checksum file mismatch; installation stopped");
})().catch(error => { console.error(error.message); process.exitCode = 1; });
NODE

printf 'Installing in %s (no sudo)…\n' "$install_prefix"
npm install --global --prefix "$install_prefix" --omit=dev --ignore-scripts=false \
  --no-audit --no-fund "$temporary/$archive_name" </dev/null
# Older published packages provide only atria. Preserve that command and expose
# the primary name without replacing any pre-existing command in this prefix.
if [ ! -e "$install_prefix/bin/coworkos" ] && [ ! -L "$install_prefix/bin/coworkos" ]; then
  node - "$install_prefix" <<'NODE'
const { realpathSync, symlinkSync } = require("node:fs");
const { join, relative, isAbsolute, sep } = require("node:path");
const prefix = process.argv[2];
const directory = realpathSync(join(prefix, "bin"));
const target = realpathSync(join(directory, "atria"));
const root = realpathSync(join(prefix, "lib/node_modules/atria-cowork-cli"));
const location = relative(root, target);
if (location === ".." || location.startsWith(`..${sep}`) || isAbsolute(location))
  throw new Error("The legacy CLI command belongs to a different installation; no alias was created");
symlinkSync(relative(directory, target), join(directory, "coworkos"));
NODE
fi
"$install_prefix/bin/coworkos" --version

if [ "${ATRIA_INSTALL_SKIP_PATH:-0}" != 1 ]; then
  node - "$install_prefix/bin" <<'NODE'
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join, dirname } = require("node:path");
const directory = process.argv[2];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const shell = (process.env.SHELL || "").split("/").pop();
const userHome = process.env.HOME;
let files = [];
let line = `export PATH=${quote(directory)}:"$PATH"`;
if (process.env.ATRIA_INSTALL_PROFILE) files = [process.env.ATRIA_INSTALL_PROFILE];
else if (shell === "zsh") files = [join(userHome, ".zshrc")];
else if (shell === "bash") {
  files = [join(userHome, ".bashrc")];
  files.push([".bash_profile", ".bash_login", ".profile"].map(name => join(userHome, name)).find(existsSync) || join(userHome, ".profile"));
}
for (const file of files) {
  const content = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (content.split("\n").includes(line)) continue;
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `\n# CoworkOS CLI\n${line}\n`);
  console.log(`Added the CLI to PATH in ${file}`);
}
NODE
fi
printf '\nCoworkOS installed. For this terminal, run:\n  export PATH=%q:"$PATH"\n\nThen configure your model and start:\n  coworkos init\n  coworkos\n' "$install_prefix/bin"
