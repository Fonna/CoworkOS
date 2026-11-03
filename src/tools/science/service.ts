import { Buffer } from "node:buffer";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessHost } from "../../runtime/process-host.js";
import {
  SCIENCE_CATALOG_VERSION,
  findScienceTool,
  scienceCatalog,
  type ScienceCatalogEntry,
  type ScienceSchema
} from "./catalog.js";

export interface ScienceToolOptions {
  enabled: boolean;
  pythonExecutable?: string;
  chemistryPythonExecutable?: string;
  catalogVersion: string;
  timeoutMs?: number;
}

export interface ScienceResult {
  ok: boolean;
  isError?: true;
  error?: { code: string; message: string };
  [key: string]: unknown;
}

export const SCIENCE_MAX_INPUT_BYTES = 1024 * 1024;
export const SCIENCE_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export function scienceFailure(
  code: string,
  message: string,
  catalogVersion: string = SCIENCE_CATALOG_VERSION
): ScienceResult {
  return { ok: false, isError: true, error: { code, message }, catalogVersion };
}

export function scienceRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate JSON values against the deliberately small, closed pilot schema vocabulary. */
export function validateScienceValue(
  value: unknown,
  schema: ScienceSchema,
  path = "arguments"
): string | undefined {
  const types = typeof schema.type === "string" ? [schema.type] : schema.type;
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (!types.includes(type) && !(type === "number" && types.includes("integer") && Number.isInteger(value)))
    return `${path} must have type ${types.join(" or ")}.`;
  if ("const" in schema && value !== schema.const)
    return `${path} must equal ${JSON.stringify(schema.const)}.`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return `${path} must be finite.`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} is below its minimum.`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} exceeds its maximum.`;
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${path} is too short.`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${path} is too long.`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return `${path} has too few samples.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return `${path} has too many samples.`;
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const error = validateScienceValue(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (scienceRecord(value) && schema.type === "object") {
    const properties = schema.properties ?? {};
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) return `${path} contains an unsupported parameter.`;
    }
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required.`;
    }
    for (const [key, member] of Object.entries(value)) {
      const error = validateScienceValue(member, properties[key]!, `${path}.${key}`);
      if (error) return error;
    }
  }
  return undefined;
}

function configurationError(options: ScienceToolOptions): ScienceResult | undefined {
  const failure = (code: string, message: string) => scienceFailure(code, message, options.catalogVersion);
  if (options.enabled !== true)
    return failure("unavailable", "Scientific computation is disabled for this session.");
  if (!scienceCatalog(options.catalogVersion))
    return failure(
      "version_unavailable",
      "The scientific catalog version is unavailable. Configure the reviewed catalog version."
    );
  const executable = options.pythonExecutable ?? "python3";
  if (
    typeof executable !== "string" ||
    !executable ||
    executable.length > 4096 ||
    /[\0\r\n]/u.test(executable) ||
    (!isAbsolute(executable) && /[/\\]/u.test(executable))
  ) {
    return failure("unavailable", "Configure an absolute Python executable path or a command name.");
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    return failure(
      "unavailable",
      "Scientific computation timeout must be an integer from 1 to 120000 milliseconds."
    );
  }
  return undefined;
}

function validJsonTree(value: unknown, depth = 0): boolean {
  if (depth > 24) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => validJsonTree(item, depth + 1));
  if (scienceRecord(value)) return Object.values(value).every((item) => validJsonTree(item, depth + 1));
  return false;
}

function decodeEnvelope(text: string, catalogVersion: string): ScienceResult {
  const failure = (code: string, message: string) => scienceFailure(code, message, catalogVersion);
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return failure("invalid_runner_response", "The scientific runner returned invalid JSON.");
  }
  if (!scienceRecord(envelope) || !validJsonTree(envelope))
    return failure("invalid_runner_response", "The scientific runner returned an invalid result envelope.");
  if (
    envelope.ok === false &&
    scienceRecord(envelope.error) &&
    typeof envelope.error.code === "string" &&
    /^[a-z_]{1,64}$/u.test(envelope.error.code) &&
    typeof envelope.error.message === "string" &&
    envelope.error.message.length <= 1000
  ) {
    return failure(envelope.error.code, envelope.error.message);
  }
  if (envelope.ok !== true || !Object.hasOwn(envelope, "result"))
    return failure("invalid_runner_response", "The scientific runner did not return a result.");
  if (
    envelope.units !== undefined &&
    typeof envelope.units !== "string" &&
    (!scienceRecord(envelope.units) ||
      !Object.values(envelope.units).every((unit) => typeof unit === "string"))
  )
    return failure("invalid_runner_response", "The scientific runner returned invalid units.");
  if (
    envelope.assumptions !== undefined &&
    (!Array.isArray(envelope.assumptions) || !envelope.assumptions.every((item) => typeof item === "string"))
  )
    return failure("invalid_runner_response", "The scientific runner returned invalid assumptions.");
  return {
    ok: true,
    catalogVersion,
    result: envelope.result,
    ...(envelope.units === undefined ? {} : { units: envelope.units }),
    ...(envelope.assumptions === undefined ? {} : { assumptions: envelope.assumptions })
  };
}

/** No inherited model credentials, proxy variables, user site packages or executable search overrides. */
function runnerEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    OMP_NUM_THREADS: "1",
    OPENBLAS_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
    NUMEXPR_NUM_THREADS: "1",
    ...(process.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {})
  };
}

async function taskSubdirectory(parent: string, name: string, root: string): Promise<string> {
  const directory = join(parent, name);
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonical = await realpath(directory);
  const relation = relative(root, canonical);
  if (isAbsolute(relation) || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("Scientific work directory escapes the task directory");
  }
  return canonical;
}

/** Execute one reviewed function in a fresh process group and an exclusive task directory. */
export async function runScienceTool(
  options: ScienceToolOptions,
  workingDirectory: string,
  entry: ScienceCatalogEntry,
  args: unknown,
  signal?: AbortSignal
): Promise<ScienceResult> {
  const reviewed = findScienceTool(entry.name, options.catalogVersion);
  // Resolve the trusted entry's pack before validating its selected interpreter.
  if (reviewed?.runtime === "chemistry" && options.chemistryPythonExecutable !== undefined)
    options = { ...options, pythonExecutable: options.chemistryPythonExecutable };
  const failure = (code: string, message: string) => scienceFailure(code, message, options.catalogVersion);
  const unavailable = configurationError(options);
  if (unavailable) return unavailable;
  if (!reviewed) return failure("unknown_tool", "That scientific function is not in the reviewed catalog.");
  entry = reviewed;
  const invalid = validateScienceValue(args, entry.parameters);
  if (invalid) return failure("invalid_arguments", invalid);
  if (entry.name === "analyze_spectrum" && scienceRecord(args)) {
    const wavelengths = args.wavelengths as number[];
    const intensities = args.intensities as number[];
    if (
      wavelengths.length !== intensities.length ||
      wavelengths.some((value, index) => index > 0 && value <= wavelengths[index - 1]!) ||
      !intensities.some((value) => value > 0)
    ) {
      return failure(
        "invalid_arguments",
        "Spectrum arrays must have equal lengths, strictly increasing wavelengths and a positive maximum intensity."
      );
    }
  }
  let request: string;
  try {
    request = JSON.stringify({ version: options.catalogVersion, tool: entry.name, arguments: args });
  } catch {
    return failure("invalid_arguments", "Scientific arguments must be JSON serializable.");
  }
  if (Buffer.byteLength(request) > SCIENCE_MAX_INPUT_BYTES)
    return failure("input_too_large", "Scientific arguments exceed the input limit.");
  if (signal?.aborted) return failure("cancelled", "Scientific computation was cancelled.");
  if (typeof workingDirectory !== "string" || !isAbsolute(workingDirectory))
    return failure("unavailable", "Scientific computation requires an absolute task working directory.");

  let directory: string;
  try {
    const root = await realpath(workingDirectory);
    const work = await taskSubdirectory(root, "work", root);
    const parent = await taskSubdirectory(work, "science", root);
    directory = await mkdtemp(join(parent, "run-"));
  } catch {
    return failure("unavailable", "Unable to create the scientific task directory.");
  }
  if (signal?.aborted) return failure("cancelled", "Scientific computation was cancelled.");

  const host = new ProcessHost();
  const runnerPath = fileURLToPath(new URL("./runner.py", import.meta.url));
  const child = host.start("science", options.pythonExecutable ?? "python3", ["-I", runnerPath], {
    cwd: directory,
    env: runnerEnvironment(directory),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  let output = "";
  let outputBytes = 0;
  let terminalFailure: ScienceResult | undefined;
  let cleanup: Promise<void> | undefined;
  const stop = () => {
    cleanup ??= host.stopKey("science", 100).catch(() => {
      terminalFailure ??= failure("cleanup_failed", "The scientific process group could not be stopped.");
    });
    return cleanup;
  };
  const fail = (code: string, message: string) => {
    terminalFailure ??= failure(code, message);
    void stop();
  };
  const onAbort = () => fail("cancelled", "Scientific computation was cancelled.");
  const timer = setTimeout(
    () => fail("timeout", "Scientific computation exceeded its configured time limit."),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );
  signal?.addEventListener("abort", onAbort, { once: true });
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > SCIENCE_MAX_OUTPUT_BYTES)
      fail("output_too_large", "The scientific runner exceeded its output limit.");
    else output += chunk;
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > SCIENCE_MAX_OUTPUT_BYTES)
      fail("output_too_large", "The scientific runner exceeded its output limit.");
  });
  child.stdin?.on("error", () => {
    /* The close/error handlers own process failure reporting. */
  });
  const closed = new Promise<number | null>((done) => {
    child.once("error", () => {
      terminalFailure ??= failure("unavailable", "The scientific Python runtime could not be started.");
    });
    child.once("exit", () => {
      void stop();
    });
    child.once("close", (code) => done(code));
  });
  if (signal?.aborted) onAbort();
  else child.stdin?.end(request);
  try {
    const code = await closed;
    await stop();
    if (terminalFailure) return terminalFailure;
    if (code !== 0) return failure("runner_failed", "The scientific runner exited unsuccessfully.");
    const result = decodeEnvelope(output, options.catalogVersion);
    return {
      ...result,
      metadata: {
        catalogVersion: options.catalogVersion,
        tool: entry.name,
        source: entry.source,
        executionDirectory: directory
      }
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    await stop();
    host.processes.delete("science");
  }
}
