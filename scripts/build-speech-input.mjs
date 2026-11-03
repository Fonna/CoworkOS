import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src/gui/macos-speech.swift");
const output = path.join(root, "dist/src/gui/atria-speech-input");
const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`;
const identifier = "org.atria.cowork.speech-input";
const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${identifier}</string>
  <key>CFBundleName</key><string>CoworkOS Speech Input</string>
  <key>CFBundleExecutable</key><string>atria-speech-input</string>
  <key>NSMicrophoneUsageDescription</key><string>CoworkOS 使用麦克风将您主动输入的语音转为消息草稿。</string>
  <key>NSSpeechRecognitionUsageDescription</key><string>CoworkOS 使用系统语音识别将语音转为草稿，优先在本机处理；本机识别不可用时，系统可能将音频发送到 Apple 的识别服务。</string>
</dict></plist>
`;
const entitlements = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
</dict></plist>
`;
const compiler = execFileSync("/usr/bin/xcrun", ["swiftc", "--version"], { encoding: "utf8" });
const hash = createHash("sha256")
  .update(target)
  .update(compiler)
  .update(await readFile(source))
  .update(await readFile(fileURLToPath(import.meta.url)))
  .update(info)
  .update(entitlements)
  .digest("hex");
if (
  (await access(output).then(
    () => true,
    () => false
  )) &&
  (await readFile(`${output}.sha256`, "utf8").catch(() => "")) === hash
)
  process.exit(0);

await mkdir(path.dirname(output), { recursive: true });
const cache = path.join(root, ".tmp/speech-input-build");
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(path.join(cache, "compile-"));
try {
  // An adjacent file named Info.plist makes codesign treat this directory as
  // a flat bundle; its resource seal would break when the standalone tool moves.
  const plist = path.join(temporary, "Embedded-Info.plist");
  const rights = path.join(temporary, "entitlements.plist");
  const binary = path.join(temporary, "atria-speech-input");
  await writeFile(plist, info);
  await writeFile(rights, entitlements);
  execFileSync(
    "/usr/bin/xcrun",
    [
      "swiftc",
      "-target",
      target,
      "-swift-version",
      "5",
      "-parse-as-library",
      "-O",
      "-module-cache-path",
      path.join(cache, "modules"),
      source,
      "-o",
      binary,
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      plist
    ],
    { stdio: "inherit" }
  );
  // A stable identifier and embedded purpose strings also support development's
  // standalone helper. Release packaging signs this Mach-O with the app identity.
  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--sign",
      "-",
      "--identifier",
      identifier,
      "--options",
      "runtime",
      "--entitlements",
      rights,
      binary
    ],
    { stdio: "inherit" }
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", binary], { stdio: "inherit" });
  await rename(binary, output);
  await writeFile(`${output}.sha256`, hash);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
