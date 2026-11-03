/** Keep application collaboration's task panel in the navigation column. */
export function createApplicationTaskPanel({ body, onShow = () => {} }) {
  let active = false;
  let applicationAvailable = false;
  let previousCollapsed = true;
  let previousSidebarCollapsed = false;
  let previousMobileOpen = false;

  function activate() {
    previousSidebarCollapsed = body.classList.contains("sidebar-collapsed");
    previousMobileOpen = body.classList.contains("sidebar-mobile-open");
    active = true;
    body.classList.remove("output-collapsed", "sidebar-collapsed", "sidebar-mobile-open");
  }

  function paint() {
    body.classList.toggle("application-task-layout", active);
    return (
      active && !body.classList.contains("output-collapsed") && !body.classList.contains("sidebar-collapsed")
    );
  }

  return {
    sync({ applicationAvailable: available, conversationVisible }) {
      const wasAvailable = applicationAvailable;
      applicationAvailable = available;
      if (available && !wasAvailable) {
        previousCollapsed = body.classList.contains("output-collapsed");
      }
      if (!available && wasAvailable) {
        if (active) {
          body.classList.toggle("sidebar-collapsed", previousSidebarCollapsed);
          body.classList.toggle("sidebar-mobile-open", previousMobileOpen);
        }
        active = false;
        body.classList.toggle("output-collapsed", previousCollapsed);
      } else if (available && conversationVisible && !active) {
        activate();
        onShow();
      }
      return paint();
    },
    toggle({ focus = true } = {}) {
      if (!applicationAvailable) return false;
      if (!active) {
        activate();
      } else body.classList.toggle("output-collapsed");
      body.classList.remove("sidebar-collapsed");
      body.classList.toggle("sidebar-mobile-open", body.classList.contains("output-collapsed"));
      if (paint()) onShow({ focus });
      return true;
    },
    toggleVisibility({ mobile = false } = {}) {
      if (!active) return false;
      const navigation = body.classList.contains("output-collapsed");
      const shown =
        navigation && mobile
          ? body.classList.contains("sidebar-mobile-open")
          : !body.classList.contains("sidebar-collapsed");
      body.classList.toggle("sidebar-collapsed", shown);
      body.classList.toggle("sidebar-mobile-open", !shown && navigation);
      if (paint()) onShow();
      return true;
    },
    get active() {
      return active;
    }
  };
}
