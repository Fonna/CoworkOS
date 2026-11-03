"use strict";

/**
 * CAD step scanner — a CJS port of coderix_main's `cad-step-scanner.ts`, which is
 * itself a focused port of cad_harness's `step-scanner.ts`.
 *
 * Groups CAD artifacts by `baseName`, classifies each as assembly / part /
 * animation frame, and surfaces a 1-based, content-addressed version number per
 * generation. Versions are archived under `history/<base>/<version>/` (immutable,
 * never overwritten); the live workspace files are surfaced as a synthetic
 * "latest" step.
 *
 * Kept electron-free (like `cad-viewer-runtime.cjs`) so it can be unit tested
 * headlessly. The only side effect is the `history/` archive write — matching
 * coderix — because cad_harness's cad-control MCP does not mint versions itself.
 */

const { createHash } = require("node:crypto");
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } = require("node:fs");
const path = require("node:path");

const ARCHIVE_DIR = "history";

const SKIPPED_DIRS = new Set([
  "node_modules",
  "__pycache__",
  ".git",
  ".cadgen",
  "__cadgen__",
  ".cache",
  "cache",
  "artifacts",
  ".claude",
  ".coderix",
  ARCHIVE_DIR,
  "frames"
]);

/** Animation frames (`frame_<n>`) are transient scaffolding, not selectable parts. */
const FRAME_RE = /^frame_\d+$/i;

/** Make a base name safe to use as a filesystem directory segment. */
function safeBaseName(name) {
  const slug = name.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return slug || "step";
}

/** Coalesce rapid-fire edits into one version (stable for this long before minting). */
const VERSION_DEBOUNCE_MS = 5 * 60 * 1000;

/** Mint a version after this many cumulative fingerprint changes, even if it never stabilizes. */
const VERSION_CHANGE_LIMIT = 10;

/** Per-artifact pending fingerprint → first-seen timestamp + change count (in-memory). */
const pendingFingerprints = new Map();

/** Recursively walk a directory, returning absolute file paths (skipping dot + skip dirs). */
function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out;
}

/**
 * Classify an artifact: under a `parts/` (or `part/`) directory = leaf part,
 * anything else = assembly, `frame_<n>` = frame.
 *
 * cad_harness's workflow (`prompt.md`) writes the assembly entry `<assembly>.step.py`
 * at the working-dir root and leaf parts under `parts/<subsystem>/<part>/`. coderix's
 * original "any slash = part" test assumes the scan root IS the working dir; CoworkOS may
 * scan a parent workspace (e.g. `…/agents/main/work/cad/`), so the `parts/`-segment test
 * keeps the assembly/part split correct in both layouts.
 */
function inferKind(files, name) {
  if (FRAME_RE.test(name)) return "frame";
  const rel = files.source || files.step;
  if (!rel) return "part";
  return rel.split("/").some((seg) => /^parts?$/.test(seg)) ? "part" : "assembly";
}

/** SHA-1 of a file's bytes — the version fingerprint. */
function fingerprintFile(absPath) {
  return createHash("sha1").update(readFileSync(absPath)).digest("hex");
}

/** The primary source-of-truth file for a group, falling back `.step` → `.glb`. */
function primaryFile(files) {
  return files.source || files.step || files.glb;
}

/** mtime (ms) of the primary source file, for "most recently updated" ordering. */
function primaryMtime(workspaceDir, files) {
  const rel = primaryFile(files);
  if (!rel) return undefined;
  try {
    return statSync(path.join(workspaceDir, rel)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Enumerate archived version numbers (1-based) under `history/<base>/`. */
function listVersions(baseDir) {
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const n = Number(entry.name);
    if (Number.isInteger(n) && n >= 1) versions.push(n);
  }
  return versions.sort((a, b) => a - b);
}

/** Fingerprint the primary source archived in `history/<base>/<version>/` (flattened to basename). */
function fingerprintArchived(baseDir, baseName, version) {
  const versionDir = path.join(baseDir, String(version));
  for (const ext of [".step.py", ".step", ".stp"]) {
    const candidate = path.join(versionDir, `${baseName}${ext}`);
    if (existsSync(candidate)) {
      try {
        return fingerprintFile(candidate);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Archive only the artifact's primary source (flattened to basename) into a version dir. */
function archiveVersion(workspaceDir, archiveDirRel, files) {
  const rel = files.source || files.step || files.glb;
  if (!rel) return undefined;
  const archiveAbs = path.join(workspaceDir, archiveDirRel);
  try {
    mkdirSync(archiveAbs, { recursive: true });
  } catch {
    /* ignore — copy fails gracefully below */
  }
  try {
    const dstRel = path.basename(rel);
    copyFileSync(path.join(workspaceDir, rel), path.join(archiveAbs, dstRel));
    return path.posix.join(archiveDirRel, dstRel);
  } catch {
    return undefined;
  }
}

/**
 * Scan a workspace and reconcile its CAD steps. Each distinct generation becomes
 * a new immutable version (archived under `history/<base>/<version>/`); the live
 * workspace files are surfaced as a synthetic "latest" step.
 */
function scanSteps(workspaceDir) {
  const relFiles = walkFiles(workspaceDir).map((abs) =>
    path.relative(workspaceDir, abs).split(path.sep).join("/")
  );

  // Group sidecar files by base name: `bracket.step.py` + `bracket.step` +
  // `bracket.glb` + `bracket.png` all belong to the `bracket` artifact.
  const groups = new Map();
  for (const rel of relFiles) {
    const base = rel.split("/").pop();
    let name = null;
    if (base.endsWith(".step.py")) name = base.slice(0, -".step.py".length);
    else if (base.endsWith(".step")) name = base.slice(0, -".step".length);
    else if (base.endsWith(".stp")) name = base.slice(0, -".stp".length);
    else if (base.endsWith(".glb")) name = base.slice(0, -".glb".length);
    else if (base.endsWith(".png")) name = base.slice(0, -".png".length);
    if (!name) continue;

    const g = groups.get(name) || {};
    if (base.endsWith(".step.py")) g.source = rel;
    else if (base.endsWith(".step") || base.endsWith(".stp")) g.step = rel;
    else if (base.endsWith(".glb")) g.glb = rel;
    else if (base.endsWith(".png")) g.snapshot = rel;
    groups.set(name, g);
  }

  const steps = [];
  for (const [name, files] of groups) {
    if (!files.source && !files.step) continue; // not a CAD artifact
    if (FRAME_RE.test(name)) continue; // animation frames are not selectable

    const kind = inferKind(files, name);
    const status = files.step ? "generated" : "generating";
    const liveFp = (() => {
      const rel = primaryFile(files);
      if (!rel) return undefined;
      try {
        return fingerprintFile(path.join(workspaceDir, rel));
      } catch {
        return undefined;
      }
    })();

    // Version detection: a new source hash mints a new version once it has been
    // stable for VERSION_DEBOUNCE_MS (or after VERSION_CHANGE_LIMIT changes), so
    // rapid-fire edits collapse into one version instead of one per keystroke.
    const baseDir = path.join(workspaceDir, ARCHIVE_DIR, safeBaseName(name));
    const existing = listVersions(baseDir);
    const now = Date.now();
    const pendingKey = `${workspaceDir}::${name}`;
    let version;
    let isNew;
    if (existing.length === 0) {
      version = 1;
      isNew = true;
    } else {
      const newest = existing[existing.length - 1];
      const archivedFp = fingerprintArchived(baseDir, name, newest);
      if (liveFp !== undefined && archivedFp === liveFp) {
        version = newest;
        isNew = false;
        pendingFingerprints.delete(pendingKey);
      } else if (liveFp === undefined) {
        version = newest;
        isNew = false;
        pendingFingerprints.delete(pendingKey);
      } else {
        const rec = pendingFingerprints.get(pendingKey);
        const isNewChange = rec === undefined || rec.fp !== liveFp;
        const changes = isNewChange ? (rec ? rec.changes : 0) + 1 : rec.changes;
        const since = isNewChange ? now : rec.since;
        const settled = !isNewChange && now - since >= VERSION_DEBOUNCE_MS;
        pendingFingerprints.set(pendingKey, { fp: liveFp, since, changes });
        if (settled || changes >= VERSION_CHANGE_LIMIT) {
          version = newest + 1;
          isNew = true;
          pendingFingerprints.delete(pendingKey);
        } else {
          version = newest;
          isNew = false;
        }
      }
    }

    const archiveDirRel = `${ARCHIVE_DIR}/${safeBaseName(name)}/${version}`;
    if (isNew) archiveVersion(workspaceDir, archiveDirRel, files);

    const base = { baseName: name, version, kind, status };

    steps.push({
      ...base,
      id: `${name}-latest`,
      name: version === 1 ? name : `${name}-${version}`,
      isLatest: true,
      viewerFile: files.source || files.step || files.glb,
      renderHash: liveFp,
      sourceMtime: primaryMtime(workspaceDir, files),
      sourcePath: files.source,
      stepPath: files.step,
      glbPath: files.glb,
      snapshotPath: files.snapshot
    });

    const allVersions = isNew ? [...existing, version] : existing;
    const primary = files.source || files.step || files.glb;
    const primaryBase = primary ? path.basename(primary) : undefined;
    for (const v of allVersions) {
      const dir = `${ARCHIVE_DIR}/${safeBaseName(name)}/${v}`;
      steps.push({
        ...base,
        id: `${name}-${v}`,
        name: v === 1 ? name : `${name}-${v}`,
        version: v,
        isLatest: false,
        viewerFile: primaryBase ? `${dir}/${primaryBase}` : undefined,
        sourcePath: files.source && primary === files.source ? `${dir}/${primaryBase}` : undefined
      });
    }
  }

  const kindOrder = { assembly: 0, part: 1, frame: 2 };
  return steps.sort(
    (a, b) =>
      kindOrder[a.kind] - kindOrder[b.kind] ||
      a.baseName.localeCompare(b.baseName) ||
      a.version - b.version ||
      (a.isLatest === b.isLatest ? 0 : a.isLatest ? 1 : -1)
  );
}

/** Highest-version step, preferring the live "latest" marker. */
function latestVersion(steps) {
  let best;
  for (const step of steps) {
    if (!best) {
      best = step;
      continue;
    }
    if (step.isLatest && !best.isLatest) {
      best = step;
      continue;
    }
    if (!step.isLatest && best.isLatest) continue;
    const v = versionOf(step);
    const bv = versionOf(best);
    if (v > bv || (v === bv && (step.sourceMtime ?? 0) > (best.sourceMtime ?? 0))) {
      best = step;
    }
  }
  return best;
}

function versionOf(step) {
  return step.version == null ? 1 : step.version;
}

function isFrameStep(step) {
  return step.kind === "frame" || FRAME_RE.test(step.baseName || step.name);
}

/**
 * Default selection on first load: the latest assembly version; if there is no
 * assembly, the latest version of the first part (baseName order).
 */
function pickDefaultStep(steps) {
  const nonFrames = steps.filter((s) => !isFrameStep(s));
  const assemblies = nonFrames.filter((s) => s.kind !== "part");
  if (assemblies.length > 0) return latestVersion(assemblies);

  const parts = nonFrames.filter((s) => s.kind === "part");
  if (parts.length === 0) return undefined;

  const byName = new Map();
  for (const p of parts) {
    const key = p.baseName || p.name;
    const list = byName.get(key);
    if (list) list.push(p);
    else byName.set(key, [p]);
  }
  const first = [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]))[0];
  return first ? latestVersion(first[1]) : undefined;
}

module.exports = { scanSteps, pickDefaultStep, latestVersion, versionOf, isFrameStep };
