export function styleDeck() {
  const text = (id, content, left = 70, top = 45, width = 860, height = 70) => ({
    id,
    type: "text",
    left,
    top,
    width,
    height,
    rotate: 0,
    content,
    defaultFontName: "Arial",
    defaultColor: "#FFFFFF",
    inset: [0, 0, 0, 0],
    fixedHeight: true
  });
  const page = text(
    "page",
    '<p style="font-size:18px;text-align:right;color:#F59B45">01 / 03</p>',
    875,
    500,
    65,
    30
  );
  const chart = {
    id: "chart",
    type: "chart",
    left: 80,
    top: 150,
    width: 800,
    height: 300,
    rotate: 0,
    chartType: "bar",
    data: { labels: ["Q1", "Q2", "Q3", "Q4目标"], legends: ["营收（万元）"], series: [[120, 150, 180, 210]] },
    themeColors: ["#F59B45"],
    textColor: "#FFFFFF",
    options: { showLegend: false, showLabel: true }
  };
  const table = {
    id: "table",
    type: "table",
    left: 70,
    top: 180,
    width: 860,
    height: 220,
    rotate: 0,
    colWidths: [0.4, 0.3, 0.3],
    cellMinHeight: 55,
    rowHeights: [55, 55, 55, 55],
    outline: { width: 1, color: "#56708C", style: "solid" },
    data: [
      ["门店类型", "营收（万元）", "毛利率"],
      ["旗舰店", "80", "65%"],
      ["社区店", "60", "60%"],
      ["商场店", "40", "55%"]
    ].map((row, r) =>
      row.map((value, c) => ({
        id: `c${r}${c}`,
        text: value,
        colspan: 1,
        rowspan: 1,
        style: {
          color: "#FFFFFF",
          backcolor: r === 0 ? "#9C4D10" : r % 2 ? "#1D3855" : "#16304B",
          fontsize: "24.5px",
          fontname: "Arial",
          bold: r === 0,
          align: c === 0 ? "left" : "center",
          vAlign: "middle"
        }
      }))
    )
  };
  return {
    viewportSize: 1000,
    viewportRatio: 0.5625,
    theme: { backgroundColor: "#10243A", fontColor: "#FFFFFF", fontName: "Arial" },
    slides: [
      {
        id: "cover",
        background: { type: "solid", color: "#10243A" },
        remark: "人工备注必须保留",
        elements: [
          {
            ...text("title", '<p style="font-size:44.5px">咖啡门店季度复盘</p>'),
            inset: [2, 4, 6, 8],
            height: 90
          },
          page
        ]
      },
      {
        id: "chart-slide",
        background: { type: "solid", color: "#10243A" },
        elements: [text("title", '<p style="font-size:36px">季度营收</p>'), chart]
      },
      {
        id: "table-slide",
        background: { type: "solid", color: "#10243A" },
        elements: [text("title", '<p style="font-size:36px">门店对比</p>'), table]
      }
    ]
  };
}
