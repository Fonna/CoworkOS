import type { ScienceCatalogEntry } from "./catalog.js";

// Task vocabulary belongs to discovery, not to the immutable function catalogs.
// Match only names present in the selected catalog, including older pinned Runs.
const intents: readonly { phrases: readonly string[]; tools: readonly string[] }[] = [
  {
    phrases: ["calibration", "standard curve", "标定", "标准曲线", "浓度反推"],
    tools: ["fit_calibration_curve"]
  },
  {
    phrases: ["background subtraction", "remove drift", "扣背景", "去背景", "去除漂移"],
    tools: ["baseline_correction"]
  },
  {
    phrases: ["find peaks", "local maxima", "找峰", "寻找峰", "峰提取"],
    tools: ["peak_detection", "analyze_spectrum"]
  },
  {
    phrases: ["dimensionality reduction", "principal component", "降维", "主成分"],
    tools: ["multivariate_analysis"]
  },
  {
    phrases: ["lipophilicity", "hydrophobicity", "脂溶性", "疏水性", "药物性质"],
    tools: ["rdkit_molecular_descriptors"]
  },
  {
    phrases: ["structure validation", "check smiles", "检查结构", "校验结构"],
    tools: ["rdkit_validate_smiles"]
  },
  {
    phrases: ["canonical smiles", "normalize smiles", "规范化结构", "统一smiles"],
    tools: ["rdkit_canonicalize_smiles"]
  },
  {
    phrases: ["monoisotopic", "exact mass", "chemical formula", "精确质量", "单同位素质量", "分子式"],
    tools: ["rdkit_exact_mass_and_formula"]
  },
  {
    phrases: ["centroid peaks", "base peak", "整理峰表", "基峰", "质谱峰表"],
    tools: ["parse_mass_spectrum_peaks"]
  },
  {
    phrases: ["isotope pattern", "chlorine atoms", "氯同位素", "同位素丰度"],
    tools: ["calculate_theoretical_isotope_pattern"]
  },
  { phrases: ["isotope cluster", "同位素簇", "匹配同位素峰"], tools: ["find_isotope_cluster"] },
  {
    phrases: ["crystallite size", "scherrer", "衍射畴尺寸", "谢乐", "晶粒尺寸"],
    tools: ["calculate_scherrer_grain_size"]
  },
  { phrases: ["unit cell geometry", "晶胞几何", "晶胞体积"], tools: ["calculate_metric_tensor"] },
  { phrases: ["cubic lattice", "立方晶格", "立方晶胞"], tools: ["cubic_lattice_parameter"] },
  {
    phrases: ["interplanar spacing", "晶面间距"],
    tools: ["bragg_law_d_spacing", "calculate_interplanar_spacing_general"]
  },
  {
    phrases: ["stellar distance", "distance in parsecs", "恒星距离", "恒星测距"],
    tools: ["distance_from_modulus"]
  },
  { phrases: ["dust reddening", "星际尘埃", "消光修正"], tools: ["calculate_extinction"] },
  { phrases: ["exoplanet dip", "行星凌星", "凌星光变"], tools: ["calculate_transit_depth"] },
  { phrases: ["revolution period", "公转周期"], tools: ["kepler_third_law"] },
  { phrases: ["electrode potential", "电极电势", "能斯特"], tools: ["nernst_potential"] },
  { phrases: ["photon conversion", "光子换算"], tools: ["eV_to_nm", "nm_to_eV"] },
  {
    phrases: [
      "data summary",
      "descriptive statistics",
      "summary statistics",
      "描述统计",
      "数据摘要",
      "样本摘要",
      "均值标准差"
    ],
    tools: ["summarize_numeric_data"]
  },
  {
    phrases: ["pearson correlation", "linear association", "皮尔逊", "线性相关", "相关系数"],
    tools: ["pearson_correlation"]
  },
  {
    phrases: ["welch", "independent sample t", "compare group means", "独立样本", "两组均值", "不等方差"],
    tools: ["welch_t_test"]
  }
];

const stopWords = new Set(
  "a an and are as at be can could compute calculate do for from get give help how i in into is it me my need of on please result results show that the these this to using value values want what with would you".split(
    " "
  )
);
const normalized = (value: string) => value.normalize("NFKC").toLowerCase();

/** Deterministic bilingual task matching; metadata only, with no model or embedding dependency. */
export function searchScienceCatalog(
  catalog: readonly ScienceCatalogEntry[],
  query: string,
  domain: string
): ScienceCatalogEntry[] {
  const text = normalized(query).trim();
  const terms = [...new Set(text.match(/[\p{L}\p{N}]+/gu) ?? [])].filter((term) => !stopWords.has(term));
  const requestedDomain = normalized(domain).trim();
  const intentTools = new Map<string, number>();
  for (const intent of intents) {
    if (!intent.phrases.some((phrase) => text.includes(phrase))) continue;
    for (const name of intent.tools) intentTools.set(name, (intentTools.get(name) ?? 0) + 8);
  }
  return catalog
    .filter(
      (entry) =>
        !requestedDomain ||
        requestedDomain === entry.domain ||
        (requestedDomain === "physics" && ["optics", "thermodynamics", "acoustics"].includes(entry.domain))
    )
    .map((entry) => {
      const haystack = normalized(
        `${entry.name} ${entry.domain} ${entry.group} ${entry.description} ${entry.keywords.join(" ")}`
      );
      const keywords = entry.keywords.filter((keyword) => text.includes(normalized(keyword))).length;
      const name = normalized(entry.name);
      const exact = text === name ? 100 : text.includes(name) ? 40 : 0;
      return {
        entry,
        score:
          exact +
          (intentTools.get(entry.name) ?? 0) +
          keywords * 3 +
          terms.filter((term) => haystack.includes(term)).length
      };
    })
    .filter(({ score }) => text.length === 0 || score > 0)
    .sort((left, right) => right.score - left.score)
    .map(({ entry }) => entry);
}
