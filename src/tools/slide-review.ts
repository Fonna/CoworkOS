import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { containsFilePath, resolveFileTarget } from "./file-path.js";
import type { RuntimeTool } from "../runtime/tool.js";
import {
  createVisionAnalyzer,
  parseVisionReview,
  type VisionModelConfig,
  type VisionReview
} from "./vision-model.js";

const DEFAULT_GOAL =
  "检查本页的可读性、遮挡、对比度、图示方向与标签对应。只报告有可见证据的问题，不要求装饰性改动。";
const OVERVIEW_GOAL =
  "检查整套预览的主题辨识度、版式节奏、重复构图与明显空白。只作整套设计观察，不推断小字是否可读；单页由独立检查覆盖。";
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Check = {
  key: string;
  path: string;
  goal: string;
  imageHash: string;
  model: string;
  attempts: number;
  status: "checking" | "pass" | "needs_revision" | "unreviewed";
  review?: VisionReview;
  report?: string;
  error?: string;
  elapsedMs?: number;
  startedAt?: string;
  finishedAt?: string;
  history?: Array<{
    attempt: number;
    startedAt: string;
    finishedAt?: string;
    status: string;
    error?: string;
    review?: VisionReview;
  }>;
};
type Slide = { path: string; goal?: string };

/** A work-conserving vision queue with a task-local, restartable evidence ledger.
 * File writes and authoring remain sequential tools; concurrency is inside this
 * bounded queue. A failed check never becomes passing evidence.
 */
export function createSlideReviewTool(options: {
  rootDirectory: string;
  taskDirectory?: string;
  reportDirectory?: string;
  assertWritableReport?: (path: string) => Promise<void>;
  workScope?: "work" | "project";
  visionModel?: VisionModelConfig;
  analyze?: ReturnType<typeof createVisionAnalyzer>;
}): RuntimeTool {
  const analyze = options.analyze ?? createVisionAnalyzer();
  const workScope = options.workScope ?? "work";
  const activeReports = new Set<string>();
  return {
    executionMode: "sequential",
    description: `Review rendered slides with the configured vision model using a bounded worker queue (default 2, maximum 4). Supply every final slide path in order and a reportPath ending in .json. Image paths may be relative or absolute inside scope=${workScope} (default) or the shared Task (scope=task). reportPath always resolves inside this Agent's own work area, independent of the image scope; returned reportScope is work. Saves real per-image evidence incrementally, reuses unchanged image+goal checks across rerenders/restarts, and allows at most two attempts per failed check. Reuse the same reportPath and goals for a deck; do not also read_image the same slides. The returned pass flag covers submitted pages only, not coverage of a whole PPT. This tool reviews pixels, not source accuracy, and never edits the PPT.`,
    parameters: {
      type: "object",
      properties: {
        slides: {
          type: "array",
          minItems: 1,
          maxItems: 80,
          items: {
            type: "object",
            properties: { path: { type: "string" }, goal: { type: "string" } },
            required: ["path"],
            additionalProperties: false
          }
        },
        reportPath: {
          type: "string",
          description:
            "JSON ledger path inside this Agent's own work area, e.g. preview/review.json. Independent of scope; reuse it after repairs."
        },
        scope: {
          type: "string",
          enum: [workScope, "task"],
          description: "Read-only root for slides and overview; does not change the ledger write directory."
        },
        overview: {
          type: "object",
          description:
            "Optional contact sheet, reviewed in the same queue alongside pages instead of blocking them.",
          properties: { path: { type: "string" }, goal: { type: "string" } },
          required: ["path"],
          additionalProperties: false
        },
        concurrency: {
          type: "integer",
          minimum: 1,
          maximum: 4,
          description: "Default 2. Increase only when provider capacity is known."
        }
      },
      required: ["slides", "reportPath"],
      additionalProperties: false
    },
    async execute(input, signal) {
      if (!input || typeof input !== "object") throw new Error("review_slides requires an object");
      const value = input as {
        slides?: Slide[];
        overview?: Slide;
        reportPath?: string;
        concurrency?: number;
        scope?: string;
      };
      if (!options.visionModel)
        throw new Error(
          "review_slides requires a configured vision model; use read_image for native-image review when no vision backend is configured"
        );
      if (!Array.isArray(value.slides) || !value.slides.length || value.slides.length > 80)
        throw new Error("review_slides requires 1–80 slide paths");
      for (const slide of [...value.slides, ...(value.overview === undefined ? [] : [value.overview])]) {
        if (
          !slide ||
          typeof slide !== "object" ||
          typeof slide.path !== "string" ||
          !slide.path.trim() ||
          (slide.goal !== undefined && (typeof slide.goal !== "string" || slide.goal.length > 4000))
        )
          throw new Error("Each slide requires a path and an optional goal of at most 4000 characters");
      }
      if (value.scope !== undefined && value.scope !== workScope && value.scope !== "task")
        throw new Error("Invalid slide review scope");
      const concurrency = value.concurrency ?? 2;
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
        throw new Error("review_slides concurrency must be 1–4");
      const requestedRoot = value.scope === "task" ? options.taskDirectory : options.rootDirectory;
      if (!requestedRoot) throw new Error("Shared Task review scope is unavailable");
      const root = await realpath(requestedRoot);
      const reportRoot = await realpath(options.reportDirectory ?? options.rootDirectory);
      const reportPath = await localPath(reportRoot, value.reportPath, true);
      if (
        extname(reportPath) !== ".json" ||
        /(?:^|\/)(?:context|\.runtime|\.codex|\.cowork|\.git|\.pi|\.agents)(?:\/|$)/.test(
          relative(reportRoot, reportPath).replaceAll("\\", "/")
        )
      )
        throw new Error("reportPath must be a task-local review JSON, not framework state");
      await options.assertWritableReport?.(reportPath);
      if (activeReports.has(reportPath))
        throw new Error(
          "This review ledger already has an active batch; wait for it instead of duplicating checks"
        );
      activeReports.add(reportPath);
      try {
        // Validate every path before sending requests or replacing an existing report.
        const specs = [
          ...(value.overview
            ? [{ ...value.overview, goal: value.overview.goal?.trim() || OVERVIEW_GOAL, overview: true }]
            : []),
          ...value.slides.map((s) => ({ ...s, overview: false }))
        ];
        const slides = await Promise.all(
          specs.map(async (slide) => {
            const path = await localPath(root, slide.path);
            const mimeType = (
              {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp"
              } as Record<string, string>
            )[extname(path).toLowerCase()];
            if (!mimeType || !(await stat(path)).isFile())
              throw new Error("review_slides accepts rendered PNG, JPEG or WebP files");
            if ((await stat(path)).size > 20 * 1024 * 1024) throw new Error("slide exceeds 20 MiB limit");
            const data = await readFile(path),
              imageHash = sha(data),
              goal = slide.goal?.trim() || DEFAULT_GOAL;
            // Page paths and API credentials are not evidence identity. Moving an
            // unchanged image must not trigger a new request; changed goals must.
            const key = sha(
              JSON.stringify([
                "slide-review-v1",
                options.visionModel!.baseUrl,
                options.visionModel!.model,
                options.visionModel!.api,
                imageHash,
                mimeType,
                goal
              ])
            );
            return {
              path: relative(root, path),
              data,
              mimeType,
              imageHash,
              goal,
              key,
              overview: slide.overview
            };
          })
        );
        let previous: { version?: number; checks?: Check[] } = {};
        try {
          previous = JSON.parse(await readFile(reportPath, "utf8"));
          if (previous.version !== 1 || !Array.isArray(previous.checks))
            throw new Error("not a review ledger");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT")
            throw new Error("Existing review ledger is unreadable; preserve it and inspect the error");
        }
        if (previous.version !== undefined && previous.version !== 1)
          throw new Error("Unsupported review ledger version");
        const checks = new Map(
          (previous.checks ?? []).map((check) => {
            if (
              !check ||
              typeof check !== "object" ||
              typeof check.key !== "string" ||
              !Number.isInteger(check.attempts) ||
              check.attempts < 0 ||
              check.attempts > 2 ||
              !["checking", "pass", "needs_revision", "unreviewed"].includes(check.status) ||
              (check.history !== undefined && !Array.isArray(check.history))
            )
              throw new Error("Existing review ledger has invalid checks; preserve it and inspect the error");
            return [check.key, check] as const;
          })
        );
        let writes = Promise.resolve();
        const startedAt = new Date().toISOString();
        const evidence = () =>
          slides.map((slide, index) => {
            const check = checks.get(slide.key);
            return {
              page: slide.overview ? null : index + (value.overview ? 0 : 1),
              kind: slide.overview ? "overview" : "slide",
              path: slide.path,
              goal: slide.goal,
              imageHash: slide.imageHash,
              model: options.visionModel!.model,
              status: check?.status ?? "unreviewed",
              review: check?.review,
              attempts: check?.attempts ?? 0,
              error: check?.error,
              elapsedMs: check?.elapsedMs,
              cached: reused.has(slide.key)
            };
          });
        const reused = new Set<string>();
        const persist = () => {
          const task = writes.then(async () => {
            await options.assertWritableReport?.(reportPath);
            const pages = evidence();
            await mkdir(dirname(reportPath), { recursive: true });
            const temp = reportPath + "." + randomUUID() + ".tmp";
            await writeFile(
              temp,
              JSON.stringify(
                {
                  version: 1,
                  reportScope: "work",
                  startedAt,
                  updatedAt: new Date().toISOString(),
                  concurrency,
                  policy:
                    "Real vision responses only. Two attempts maximum per image+goal; unchanged evidence may be reused. Pixel review does not authenticate facts. This is not a PPT delivery certificate.",
                  slides: pages.filter((p) => p.kind === "slide"),
                  overview: pages.find((p) => p.kind === "overview"),
                  everySubmittedPagePassed: pages
                    .filter((p) => p.kind === "slide")
                    .every((p) => p.status === "pass"),
                  checks: [...checks.values()]
                },
                null,
                2
              ) + "\n"
            );
            await rename(temp, reportPath);
          });
          writes = task;
          return task;
        };
        const unique = [...new Map(slides.map((s) => [s.key, s])).values()];
        // Keep retry counts even across process restarts. Malformed cached
        // evidence cannot be promoted to a pass.
        for (const slide of unique) {
          const old = checks.get(slide.key);
          if (old && ["pass", "needs_revision"].includes(old.status) && old.review) {
            try {
              const raw = parseVisionReview(old.report ?? "");
              if (
                old.imageHash === slide.imageHash &&
                raw.status === old.status &&
                JSON.stringify(raw) === JSON.stringify(old.review)
              )
                reused.add(slide.key);
            } catch {
              /* Invalid evidence remains unreviewed, with its original retry budget. */
            }
          }
          if (old && !reused.has(slide.key)) {
            old.status = "unreviewed";
            delete old.review;
          }
        }
        await persist();
        let cursor = 0;
        await Promise.all(
          Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
            while (cursor < unique.length) {
              if (signal?.aborted) break;
              const slide = unique[cursor++];
              if (reused.has(slide.key)) continue;
              let check = checks.get(slide.key);
              if (!check) {
                check = {
                  key: slide.key,
                  path: slide.path,
                  goal: slide.goal,
                  imageHash: slide.imageHash,
                  model: options.visionModel!.model,
                  attempts: 0,
                  status: "unreviewed"
                };
                checks.set(slide.key, check);
              }
              while (check.attempts < 2) {
                if (signal?.aborted) break;
                check.attempts += 1;
                check.status = "checking";
                check.startedAt = new Date().toISOString();
                const attempt = {
                  attempt: check.attempts,
                  startedAt: check.startedAt,
                  status: "checking"
                } as NonNullable<Check["history"]>[number];
                (check.history ??= []).push(attempt);
                delete check.review;
                delete check.error;
                await persist(); // Charge the attempt before remote execution.
                try {
                  const result = await analyze(
                    options.visionModel!,
                    {
                      data: slide.data,
                      mimeType: slide.mimeType,
                      path: slide.path,
                      goal: slide.goal,
                      review: true
                    },
                    signal
                  );
                  if (!result.review) throw new Error("vision response has no structured review");
                  check.review = result.review;
                  check.report = result.report;
                  check.status = result.review.status;
                  check.elapsedMs = result.elapsedMs;
                } catch (error) {
                  check.status = "unreviewed";
                  check.error = error instanceof Error ? error.message : "vision request failed";
                }
                check.finishedAt = new Date().toISOString();
                Object.assign(attempt, {
                  finishedAt: check.finishedAt,
                  status: check.status,
                  error: check.error,
                  review: check.review
                });
                await persist();
                if (check.status === "pass" || check.status === "needs_revision") break;
              }
              if (check.status === "checking") check.status = "unreviewed";
            }
          })
        );
        await persist();
        const pages = evidence();
        return {
          reportPath: relative(reportRoot, reportPath),
          reportScope: "work",
          concurrency,
          slides: pages.filter((p) => p.kind === "slide"),
          overview: pages.find((p) => p.kind === "overview"),
          everySubmittedPagePassed: pages.filter((p) => p.kind === "slide").every((p) => p.status === "pass"),
          summary: {
            total: pages.length,
            reused: pages.filter((p) => p.cached).length,
            pass: pages.filter((p) => p.status === "pass").length,
            needsRevision: pages.filter((p) => p.status === "needs_revision").length,
            unreviewed: pages.filter((p) => p.status === "unreviewed").length
          }
        };
      } finally {
        activeReports.delete(reportPath);
      }
    }
  };
}

/** Reject traversal and symlink escape, including a not-yet-created output path. */
async function localPath(root: string, path: unknown, writable = false): Promise<string> {
  if (typeof path !== "string" || !path) throw new Error("slide/report path is required");
  const target = resolve(root, path);
  if (!isAbsolute(path) && !containsFilePath(root, target))
    throw new Error("slide/report path escapes its allowed root");
  // Resolve aliases before testing absolute paths. On macOS /var and /tmp
  // commonly alias /private/var and /private/tmp, including render outputs.
  const resolved = writable ? await resolveFileTarget(target) : await realpath(target);
  if (!containsFilePath(root, resolved) || resolved === root)
    throw new Error("slide/report path escapes its allowed root");
  return resolved;
}
