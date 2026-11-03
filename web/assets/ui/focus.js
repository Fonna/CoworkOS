/** Follow same-origin editor frames so shell dialogs can return to their trigger. */
export function focusedControl(root = document) {
  let control = root.activeElement;
  try {
    while (control?.localName === "iframe") {
      const nested = control.contentDocument?.activeElement;
      if (!nested || nested === control.contentDocument.body) break;
      control = nested;
    }
  } catch {
    // Cross-origin frames retain their outer focus target.
  }
  return control;
}
