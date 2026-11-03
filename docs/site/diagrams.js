import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontSize: "14px",
    primaryColor: "#f0efff",
    primaryTextColor: "#302b67",
    primaryBorderColor: "#a49bdf",
    lineColor: "#8f89ae",
    secondaryColor: "#eef5ff",
    tertiaryColor: "#f7f5ff"
  },
  flowchart: { useMaxWidth: true, htmlLabels: false, curve: "basis" }
});
try {
  await mermaid.run({ nodes: document.querySelectorAll(".mermaid") });
  document.documentElement.dataset.diagrams = "ready";
} catch {
  document.documentElement.dataset.diagrams = "error";
}
