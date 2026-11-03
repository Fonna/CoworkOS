/** Keep the latest answer visible when the composer or window changes height. */
export function createConversationLayout(scroll) {
  let height = scroll.clientHeight;
  let following = scroll.scrollHeight - scroll.scrollTop - height < 100;
  const trackPosition = () => {
    // A viewport resize may dispatch scroll before ResizeObserver. Preserve the
    // user's pre-resize intent until the new viewport has been handled.
    if (scroll.clientHeight !== height) return;
    following = scroll.scrollHeight - scroll.scrollTop - height < 100;
  };
  scroll.addEventListener("scroll", trackPosition, { passive: true });
  const observer = new ResizeObserver(() => {
    const nextHeight = scroll.clientHeight;
    if (nextHeight === height) return;
    height = nextHeight;
    if (following) scroll.scrollTop = scroll.scrollHeight;
  });
  observer.observe(scroll);
  return () => {
    observer.disconnect();
    scroll.removeEventListener("scroll", trackPosition);
  };
}
