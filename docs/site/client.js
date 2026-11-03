const english = document.documentElement.lang === "en";
const labels = english
  ? {
      copy: "Copy",
      copied: "Copied",
      failed: "Select to copy",
      empty: "No results"
    }
  : {
      copy: "复制",
      copied: "已复制",
      failed: "请选择并复制",
      empty: "无结果"
    };
const copyIcon =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4"/></svg>';
const copiedIcon =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>';

const menu = document.querySelector(".mobile-menu");
menu?.addEventListener("click", () => {
  const open = document.body.classList.toggle("menu-open");
  menu.setAttribute("aria-expanded", String(open));
});
document.querySelector(".sidebar-backdrop")?.addEventListener("click", closeMenu);
function closeMenu() {
  document.body.classList.remove("menu-open");
  menu?.setAttribute("aria-expanded", "false");
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
});
document.querySelector('.sidebar a[aria-current="page"]')?.scrollIntoView({ block: "nearest" });

const applicationInfo = [...document.querySelectorAll(".application-info")];
function showApplicationInfo(button, open) {
  for (const other of applicationInfo) other.setAttribute("aria-expanded", String(other === button && open));
}
for (const button of applicationInfo) {
  button.classList.add("is-enhanced");
  button.addEventListener("mouseenter", () => showApplicationInfo(button, true));
  button.addEventListener("focus", () => showApplicationInfo(button, true));
  button.addEventListener("click", () => showApplicationInfo(button, true));
  button.addEventListener("mouseleave", () => {
    if (document.activeElement !== button) showApplicationInfo(button, false);
  });
  button.addEventListener("blur", () => showApplicationInfo(button, false));
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") showApplicationInfo(button, false);
  });
}
document.addEventListener("click", (event) => {
  if (!event.target.closest(".application-info")) showApplicationInfo(null, false);
});

function selectTab(group, index, focus = false) {
  const buttons = [...group.querySelectorAll('[role="tab"]')];
  const panels = [...group.querySelectorAll("[data-tab-panel]")];
  buttons.forEach((button, i) => {
    button.setAttribute("aria-selected", String(i === index));
    button.tabIndex = i === index ? 0 : -1;
    panels[i].hidden = i !== index;
  });
  if (focus) buttons[index].focus();
}

function revealAnchor(hash, scroll = false) {
  let id;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    return;
  }
  const target = document.getElementById(id);
  const panel = target?.closest("[data-tab-panel]");
  const group = panel?.closest("[data-tabs]");
  if (group) {
    selectTab(group, [...group.querySelectorAll("[data-tab-panel]")].indexOf(panel));
    if (scroll) target.scrollIntoView({ block: "start" });
  }
}

for (const group of document.querySelectorAll("[data-tabs]")) {
  const buttons = [...group.querySelectorAll('[role="tab"]')];
  const panels = [...group.querySelectorAll("[data-tab-panel]")];
  group.classList.add("is-enhanced");
  group.querySelector('[role="tablist"]').hidden = false;
  selectTab(group, 0);
  buttons.forEach((button, index) => {
    const change = (i, focus) => {
      selectTab(group, i, focus);
      const heading = panels[i].querySelector("h2[id]");
      if (heading) history.replaceState(null, "", `#${encodeURIComponent(heading.id)}`);
    };
    button.addEventListener("click", () => change(index, false));
    button.addEventListener("keydown", (event) => {
      const key = event.key;
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(key)) return;
      event.preventDefault();
      const next =
        key === "Home"
          ? 0
          : key === "End"
            ? buttons.length - 1
            : (index + (key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
      change(next, true);
    });
  });
}
revealAnchor(location.hash, true);
window.addEventListener("hashchange", () => revealAnchor(location.hash, true));
document.addEventListener("click", (event) => {
  const link = event.target.closest("a[href]");
  if (!link) return;
  const target = new URL(link.href, location.href);
  if (target.origin === location.origin && target.pathname === location.pathname && target.hash)
    revealAnchor(target.hash);
});

for (const pre of document.querySelectorAll("pre:has(> code)")) {
  const block = document.createElement("div");
  block.className = "code-block";
  pre.before(block);
  block.append(pre);
  const button = document.createElement("button");
  button.className = "copy-code icon-button";
  button.type = "button";
  const tooltip = document.createElement("span");
  tooltip.className = "tooltip";
  tooltip.setAttribute("role", "tooltip");
  const display = (label, icon = copyIcon) => {
    button.setAttribute("aria-label", label);
    tooltip.textContent = label;
    button.innerHTML = icon;
    button.append(tooltip);
  };
  display(labels.copy);
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector("code").textContent);
      display(labels.copied, copiedIcon);
    } catch {
      display(labels.failed);
    }
    setTimeout(() => {
      display(labels.copy);
    }, 1800);
  });
  block.append(button);
}

const tocLinks = [...document.querySelectorAll(".toc-links a")];
const observer = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      for (const link of tocLinks) {
        if (decodeURIComponent(link.hash.slice(1)) === entry.target.id)
          link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    }
  },
  { rootMargin: "-80px 0px -65% 0px" }
);
for (const heading of document.querySelectorAll(".article h2, .article h3")) observer.observe(heading);

const dialog = document.querySelector(".search-dialog");
const searchInput = dialog.querySelector(".search-input");
const searchResults = dialog.querySelector(".search-results");
const searchAll = dialog.querySelector("[data-search-all]");
const assetBase = new URL(".", import.meta.url);
let indexPromise;
let searchGeneration = 0;
let selected = -1;

function openSearch() {
  closeMenu();
  if (!dialog.open) dialog.showModal();
  searchInput.focus();
  indexPromise ??= fetch(new URL("search-index.json", assetBase)).then((response) => {
    if (!response.ok) throw new Error("Search index unavailable");
    return response.json();
  });
  // Preloading is optional; input handler displays a readable failure if it cannot load.
  indexPromise.catch(() => {});
  void search();
}
for (const button of document.querySelectorAll("[data-search]")) button.addEventListener("click", openSearch);
dialog.querySelector("[data-close-search]").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});
document.addEventListener("keydown", (event) => {
  const typing =
    /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (
    (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) ||
    (event.key === "/" && !typing)
  ) {
    event.preventDefault();
    openSearch();
  }
});

function appendHighlight(element, text, terms) {
  const lower = text.toLocaleLowerCase();
  let position = 0;
  while (position < text.length) {
    const found = terms
      .map((term) => ({ term, at: lower.indexOf(term, position) }))
      .filter((item) => item.at !== -1)
      .sort((a, b) => a.at - b.at)[0];
    if (!found) {
      element.append(document.createTextNode(text.slice(position)));
      break;
    }
    element.append(document.createTextNode(text.slice(position, found.at)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(found.at, found.at + found.term.length);
    element.append(mark);
    position = found.at + found.term.length;
  }
}
function selectResult(index) {
  const links = [...searchResults.querySelectorAll("a")];
  selected = links.length ? (index + links.length) % links.length : -1;
  links.forEach((link, i) => link.classList.toggle("is-active", i === selected));
  if (selected >= 0) {
    searchInput.setAttribute("aria-activedescendant", links[selected].id);
    links[selected].scrollIntoView({ block: "nearest" });
  } else searchInput.removeAttribute("aria-activedescendant");
}
async function search() {
  const generation = ++searchGeneration;
  const query = searchInput.value.trim().toLocaleLowerCase();
  searchResults.replaceChildren();
  searchInput.removeAttribute("aria-activedescendant");
  selected = -1;
  if (!query) return;
  try {
    const pages = await indexPromise;
    if (generation !== searchGeneration) return;
    const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
    const matches = pages
      .map((page) => {
        if (!searchAll.checked && page.audience !== "user") return null;
        const haystack = `${page.title} ${page.heading} ${page.text}`.toLocaleLowerCase();
        if (!terms.every((term) => haystack.includes(term))) return null;
        const title = page.title.toLocaleLowerCase();
        const heading = page.heading.toLocaleLowerCase();
        const score =
          terms.reduce(
            (total, term) => total + (title.includes(term) ? 12 : 0) + (heading.includes(term) ? 7 : 0),
            0
          ) + (page.lang === (english ? "en" : "zh") ? 4 : 0);
        return { ...page, score };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    // Avoid letting many sections of one long reference crowd out other guides.
    const seen = new Map();
    const results = matches
      .filter((page) => {
        const count = seen.get(page.file) || 0;
        seen.set(page.file, count + 1);
        return count < 2;
      })
      .slice(0, 24);
    if (!results.length) {
      const status = document.createElement("p");
      status.className = "search-empty";
      status.textContent = labels.empty;
      searchResults.append(status);
    }
    results.forEach((page, i) => {
      const link = document.createElement("a");
      link.className = "search-result";
      link.id = `search-result-${i}`;
      link.href = new URL(page.url, assetBase).href;
      const title = document.createElement("strong");
      appendHighlight(
        title,
        page.title + (page.heading && page.heading !== page.title ? ` › ${page.heading}` : ""),
        terms
      );
      const excerpt = document.createElement("span");
      const at = Math.max(0, page.text.toLocaleLowerCase().indexOf(terms[0]) - 42);
      appendHighlight(
        excerpt,
        `${at ? "…" : ""}${page.text.slice(at, at + 155)}${page.text.length > at + 155 ? "…" : ""}`,
        terms
      );
      link.append(title, excerpt);
      if (page.lang !== (english ? "en" : "zh")) {
        const meta = document.createElement("small");
        meta.textContent = page.lang === "en" ? "English" : "中文";
        link.append(meta);
      }
      link.addEventListener("mousemove", () => selectResult(i));
      link.addEventListener("click", () => dialog.close());
      searchResults.append(link);
    });
  } catch {
    if (generation === searchGeneration)
      searchResults.textContent = english
        ? "Search could not load. Reload the page to retry."
        : "搜索暂时无法加载，请刷新页面重试。";
  }
}
searchInput.addEventListener("input", () => {
  void search();
});
searchAll.addEventListener("change", () => {
  void search();
});
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    dialog.close();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selectResult(
      selected < 0 ? (event.key === "ArrowDown" ? 0 : -1) : selected + (event.key === "ArrowDown" ? 1 : -1)
    );
  } else if (event.key === "Enter") {
    const links = searchResults.querySelectorAll("a");
    links[selected >= 0 ? selected : 0]?.click();
  }
});

if (document.querySelector(".mermaid")) {
  import("./diagrams.js").catch(() => {
    // Preserve readable Mermaid source when a browser cannot render a diagram.
    document.documentElement.dataset.diagrams = "error";
  });
}
