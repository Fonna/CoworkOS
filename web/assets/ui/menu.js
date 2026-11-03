/** Keyboard and dismissal behavior shared by application menus and document pickers. */
export function createMenu(
  trigger,
  panel,
  { onOpen, onClose, toggleOnClick = true, closeOnSelect = true } = {}
) {
  const items = () =>
    [...panel.querySelectorAll('button:not(:disabled), a[href], [role="option"]')].filter(
      (item) => item.getAttribute("aria-disabled") !== "true" && !item.closest("[hidden]")
    );
  const close = (restoreFocus = false) => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    onClose?.();
    if (restoreFocus && trigger.isConnected) trigger.focus();
  };
  const open = () => {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    onOpen?.();
    items()[0]?.focus();
  };
  const toggle = () => (panel.hidden ? open() : close(true));
  const keys = (event) => {
    if (panel.hidden) {
      if (event.currentTarget === trigger && ["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        if (toggleOnClick) open();
        else trigger.click();
        if (event.key === "ArrowUp") items().at(-1)?.focus();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      close(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const options = items(),
        index = options.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
  };
  const outside = (event) => {
    if (!trigger.contains(event.target) && !panel.contains(event.target)) close();
  };
  const choose = (event) => {
    if (closeOnSelect && event.target.closest('button:not(:disabled), a[href], [role="option"]')) close(true);
  };
  if (toggleOnClick) trigger.addEventListener("click", toggle);
  trigger.addEventListener("keydown", keys);
  panel.addEventListener("keydown", keys);
  panel.addEventListener("click", choose);
  document.addEventListener("pointerdown", outside);
  return {
    open,
    close,
    setTrigger(next) {
      trigger.setAttribute("aria-expanded", "false");
      trigger.removeEventListener("click", toggle);
      trigger.removeEventListener("keydown", keys);
      trigger = next;
      trigger.setAttribute("aria-expanded", String(!panel.hidden));
      if (toggleOnClick) trigger.addEventListener("click", toggle);
      trigger.addEventListener("keydown", keys);
    },
    dispose() {
      close();
      trigger.removeEventListener("click", toggle);
      trigger.removeEventListener("keydown", keys);
      panel.removeEventListener("keydown", keys);
      panel.removeEventListener("click", choose);
      document.removeEventListener("pointerdown", outside);
    }
  };
}
