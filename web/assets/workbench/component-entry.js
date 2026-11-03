/** Open the shared component settings from an editor or embedded application. */
export function openComponentSettings(componentId, target = document) {
  target.dispatchEvent(new CustomEvent("atria:component-settings", { detail: { componentId } }));
}
