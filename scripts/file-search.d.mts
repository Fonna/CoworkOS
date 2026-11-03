export interface FindParameters {
  pattern: string;
  path?: string;
  limit?: number;
}
export interface GrepParameters extends FindParameters {
  glob?: string;
  literal?: boolean;
  ignoreCase?: boolean;
  context?: number;
}
export interface FindResult {
  paths: string[];
  limitReached: boolean;
}
export interface GrepResult {
  text: string;
  matchCount: number;
  limitReached: boolean;
  skippedFiles: string[];
  outputLimitReached: boolean;
  linesTruncated: boolean;
  matches: { path: string; lineNumber: number; line: string }[];
}
export interface SearchOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export function findFiles(parameters: FindParameters, cwd?: string): Promise<FindResult>;
export function grepFiles(parameters: GrepParameters, cwd?: string): Promise<GrepResult>;
export function runFileSearch(
  operation: "find",
  parameters: FindParameters,
  options?: SearchOptions
): Promise<FindResult>;
export function runFileSearch(
  operation: "grep",
  parameters: GrepParameters,
  options?: SearchOptions
): Promise<GrepResult>;
