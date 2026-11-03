import {
  createFindToolDefinition,
  createGrepToolDefinition,
  truncateHead,
  formatSize
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runFileSearch } from "../../../scripts/file-search.mjs";

/** Keep Pi's public schemas and renderers while using the portable search provider. */
export function registerSearchTools(pi: ExtensionAPI, projectDirectory: string) {
  const find = createFindToolDefinition(projectDirectory);
  pi.registerTool({
    ...find,
    async execute(_id, params, signal, _update, ctx) {
      const result = await runFileSearch("find", params, { cwd: ctx.cwd || projectDirectory, signal });
      if (!result.paths.length)
        return { content: [{ type: "text", text: "No files found matching pattern" }], details: undefined };
      const truncation = truncateHead(result.paths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
      const details: { resultLimitReached?: number; truncation?: typeof truncation } = {};
      const notices: string[] = [];
      if (result.limitReached) {
        details.resultLimitReached = params.limit ?? 1000;
        notices.push(`${details.resultLimitReached} results limit reached`);
      }
      if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
      }
      const text = `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`;
      return {
        content: [{ type: "text", text }],
        details: Object.keys(details).length ? details : undefined
      };
    }
  });
  const grep = createGrepToolDefinition(projectDirectory);
  pi.registerTool({
    ...grep,
    async execute(_id, params, signal, _update, ctx) {
      const result = await runFileSearch("grep", params, { cwd: ctx.cwd || projectDirectory, signal });
      const truncation = truncateHead(result.text || "No matches found", {
        maxLines: Number.MAX_SAFE_INTEGER
      });
      const details: {
        matchLimitReached?: number;
        truncation?: typeof truncation;
        skippedFiles?: string[];
        outputLimitReached?: boolean;
        linesTruncated?: boolean;
      } = {};
      const notices: string[] = [];
      if (result.limitReached) {
        details.matchLimitReached = params.limit ?? 100;
        notices.push(`${details.matchLimitReached} matches limit reached. Refine pattern or increase limit`);
      }
      if (truncation.truncated) {
        details.truncation = truncation;
        notices.push(`${formatSize(truncation.maxBytes)} limit reached`);
      }
      if (result.outputLimitReached) {
        details.outputLimitReached = true;
        notices.push("64KB search output limit reached. Refine pattern or narrow path");
      }
      if (result.linesTruncated) {
        details.linesTruncated = true;
        notices.push("Some lines truncated to 1000 chars. Use read to see full lines");
      }
      if (result.skippedFiles.length) {
        details.skippedFiles = result.skippedFiles;
        notices.push(
          `${result.skippedFiles.length} oversized files skipped. Use read to inspect specific files`
        );
      }
      const text = `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}`;
      return {
        content: [{ type: "text", text }],
        details: Object.keys(details).length ? details : undefined
      };
    }
  });
}
