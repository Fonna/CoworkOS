import { join } from "node:path";
import type { McpServerSpec } from "../../types.js";
import {
  resolveOfficeHarnessMcpPath,
  resolveOfficeHarnessNode,
  resolveOfficeHarnessProfile
} from "./paths.js";

/**
 * The external `officeharness` stdio MCP server (a Node server launched with the
 * plugin's bundled runtime). The agent edits a browser-hosted Impress WASM deck
 * through its `ppt_*` tools, sharing one host and profile with the embedded
 * editor panel.
 *
 * Declared, not registered: the platform's {@link McpSupervisor} starts it when
 * a bound window needs tools and stops it when the last window closes. The
 * `OFFICEHARNESS_MANAGED_HOST` / `OFFICEHARNESS_CONNECTION_FILE` env tell the
 * server to attach to the same managed host the desktop preview starts (rather
 * than launching its own), which is what makes the MCP tools and the visible
 * editor operate on the same document.
 */
export function buildOfficeHarnessMcpServerSpec(): McpServerSpec {
  return {
    command: resolveOfficeHarnessNode(),
    args: [resolveOfficeHarnessMcpPath()],
    env: {
      OFFICEHARNESS_MANAGED_HOST: "1",
      OFFICEHARNESS_CONNECTION_FILE: join(resolveOfficeHarnessProfile(), "connection.json")
    }
  };
}
