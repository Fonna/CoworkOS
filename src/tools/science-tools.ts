import type { RuntimeTool } from "../runtime/tool.js";
import {
  SCIENCE_CATALOG_VERSION,
  SCIENCE_ASTRONOMY_CATALOG_VERSION,
  SCIENCE_CHEMISTRY_CATALOG_VERSION,
  SCIENCE_MATERIALS_CATALOG_VERSION,
  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
  SCIENCE_STATISTICS_CATALOG_VERSION,
  findScienceTool,
  scienceCatalog
} from "./science/catalog.js";
import { runScienceTool, scienceFailure, scienceRecord, type ScienceToolOptions } from "./science/service.js";
import { searchScienceCatalog } from "./science/discovery.js";

export {
  SCIENCE_CATALOG,
  SCIENCE_CATALOG_VERSION,
  SCIENCE_PILOT_CATALOG_VERSION,
  SCIENCE_ANALYSIS_CATALOG_VERSION,
  SCIENCE_ASTRONOMY_CATALOG_VERSION,
  DEFAULT_SCIENCE_CATALOG_VERSION,
  SCIENCE_CHEMISTRY_CATALOG_VERSION,
  SCIENCE_MATERIALS_CATALOG_VERSION,
  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION,
  SCIENCE_STATISTICS_CATALOG_VERSION,
  scienceCatalog
} from "./science/catalog.js";
export type { ScienceCatalogEntry } from "./science/catalog.js";
export type { ScienceToolOptions, ScienceResult } from "./science/service.js";

function inputRecord(input: unknown, allowed: readonly string[]): Record<string, unknown> | undefined {
  if (!scienceRecord(input) || Object.keys(input).some((key) => !allowed.includes(key))) return undefined;
  return input;
}

/** Exactly three stable model-facing tools. Discovery reads only static, reviewed metadata. */
export function createScienceTools(
  options: ScienceToolOptions,
  context: { workingDirectory: string }
): ReadonlyMap<string, RuntimeTool> {
  const configured = { ...options };
  const catalog = scienceCatalog(configured.catalogVersion);
  const failure = (code: string, message: string) => scienceFailure(code, message, configured.catalogVersion);
  return new Map<string, RuntimeTool>([
    [
      "science_search",
      {
        description:
          "Search the reviewed scientific function catalog. This reads metadata only. Describe a matching function before running it; results are scientific calculations under stated assumptions.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 512 },
            domain: {
              type: "string",
              description:
                configured.catalogVersion === SCIENCE_STATISTICS_CATALOG_VERSION
                  ? "Optional domain: optics, thermodynamics, acoustics, chemistry, materials_science, astronomy or statistics."
                  : configured.catalogVersion === SCIENCE_CATALOG_VERSION
                    ? "Optional domain: optics, thermodynamics or acoustics."
                    : [
                          SCIENCE_ASTRONOMY_CATALOG_VERSION,
                          SCIENCE_CHEMISTRY_CATALOG_VERSION,
                          SCIENCE_MATERIALS_CATALOG_VERSION,
                          SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION
                        ].includes(configured.catalogVersion)
                      ? "Optional domain: optics, thermodynamics, acoustics, chemistry, materials_science or astronomy."
                      : "Optional domain: optics, thermodynamics, acoustics, chemistry or materials_science.",
              maxLength: 64
            },
            limit: { type: "integer", minimum: 1, maximum: 12, default: 6 }
          },
          additionalProperties: false
        },
        execute: async (raw) => {
          if (!catalog)
            return failure("version_unavailable", "The scientific catalog version is unavailable.");
          const input = inputRecord(raw, ["query", "domain", "limit"]);
          if (
            !input ||
            (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 512)) ||
            (input.domain !== undefined && (typeof input.domain !== "string" || input.domain.length > 64)) ||
            (input.limit !== undefined &&
              (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 12))
          )
            return failure(
              "invalid_arguments",
              "Use a query of at most 512 characters, an optional domain and an integer limit from 1 to 12."
            );
          const matches = searchScienceCatalog(
            catalog,
            String(input.query ?? ""),
            String(input.domain ?? "")
          );
          return {
            ok: true,
            catalogVersion: configured.catalogVersion,
            total: matches.length,
            tools: matches.slice(0, Number(input.limit ?? 6)).map((entry) => ({
              name: entry.name,
              domain: entry.domain,
              group: entry.group,
              description: entry.description,
              dependencies: entry.dependencies
            }))
          };
        }
      }
    ],
    [
      "science_describe",
      {
        description:
          configured.catalogVersion === SCIENCE_STATISTICS_CATALOG_VERSION
            ? "Read the exact scientific function schema, units, assumptions, dependencies, example and declared provenance, including native statistics and RDKit wrappers. This reads metadata only and does not probe Python."
            : [
                  SCIENCE_CHEMISTRY_CATALOG_VERSION,
                  SCIENCE_MATERIALS_CATALOG_VERSION,
                  SCIENCE_MASS_SPECTROMETRY_CATALOG_VERSION
                ].includes(configured.catalogVersion)
              ? "Read the exact scientific function schema, units, assumptions, dependencies, example and declared provenance, including native RDKit wrappers. This reads metadata only and does not probe Python."
              : "Read the exact scientific function schema, units, assumptions, dependencies, example and pinned upstream provenance. This reads metadata only and does not probe Python.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", maxLength: 128 } },
          required: ["name"],
          additionalProperties: false
        },
        execute: async (raw) => {
          if (!catalog)
            return failure("version_unavailable", "The scientific catalog version is unavailable.");
          const input = inputRecord(raw, ["name"]);
          if (!input || typeof input.name !== "string" || input.name.length > 128)
            return failure("invalid_arguments", "A reviewed scientific function name is required.");
          const entry = findScienceTool(input.name, configured.catalogVersion);
          return entry
            ? { ok: true, catalogVersion: configured.catalogVersion, ...entry }
            : failure("unknown_tool", "That scientific function is not in the reviewed catalog.");
        }
      }
    ],
    [
      "science_run",
      {
        description:
          configured.catalogVersion === SCIENCE_CATALOG_VERSION
            ? "Run one reviewed scientific function by its exact catalog name and schema. Use science_describe first; supply its units and check assumptions. Only the reviewed pilot functions are executable. Errors do not constitute scientific results."
            : "Run one reviewed scientific function by its exact catalog name and schema. Use science_describe first; supply its units and check assumptions. Only functions in this Run's pinned catalog are executable. Errors do not constitute scientific results.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", maxLength: 128 },
            arguments: {
              type: "object",
              description:
                "Arguments matching the schema returned by science_describe. No file paths, Python code or runtime options are accepted."
            }
          },
          required: ["name", "arguments"],
          additionalProperties: false
        },
        execute: async (raw, signal) => {
          try {
            if (!catalog)
              return failure("version_unavailable", "The scientific catalog version is unavailable.");
            const input = inputRecord(raw, ["name", "arguments"]);
            if (
              !input ||
              typeof input.name !== "string" ||
              input.name.length > 128 ||
              !scienceRecord(input.arguments)
            )
              return failure(
                "invalid_arguments",
                "Use an exact reviewed function name and an arguments object."
              );
            const entry = findScienceTool(input.name, configured.catalogVersion);
            if (!entry)
              return failure("unknown_tool", "That scientific function is not in the reviewed catalog.");
            return await runScienceTool(configured, context.workingDirectory, entry, input.arguments, signal);
          } catch {
            return failure("internal_error", "Scientific computation failed before a result was available.");
          }
        }
      }
    ]
  ]);
}
