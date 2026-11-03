type SessionView = {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  getEntries(): unknown[];
};

export const CLI_TASK_ENTRY: string;
export function canonical(path: string): Promise<string>;
export function allProjectSessions(
  agentDir: string
): Promise<import("@earendil-works/pi-coding-agent").SessionInfo[]>;
export function recordCliSessionBinding(input: {
  sessionManager: SessionView;
  workspaceRoot: string;
  taskId: string;
  projectDirectory: string;
  appendEntry: (type: string, data: unknown) => unknown;
  allowOverride?: boolean;
}): Promise<{ status: "skipped" | "unchanged" | "conflict" | "recorded"; data?: unknown }>;

export function resolveCliSession(input: {
  args: string[];
  workspaceRoot: string;
  projectDirectory: string;
  agentDir: string;
  explicitTaskId?: string;
  env?: Record<string, string | undefined>;
}): Promise<{
  cancelled?: boolean;
  taskId?: string;
  projectDirectory?: string;
  sessionPath?: string;
  sessionId?: string;
  sessionDirectory?: string;
}>;
