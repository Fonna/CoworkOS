import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerCoworkExtension from "../runtime/extension.ts";

/** Pi discovers this entry; feature registrations and runtime state live in separate modules. */
export default function cowork(pi: ExtensionAPI) {
  return registerCoworkExtension(pi);
}
