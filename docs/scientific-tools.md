# 可选科学计算工具

[English](en/scientific-tools.md) | 中文

CoworkOS 提供 40 个离线科学函数：33 个适配自固定版本 SciAgentGYM，另有 4 个 CoworkOS 原生 RDKit 分子工具和 3 个原生统计函数。它们通过 `science_search`、`science_describe`、`science_run` 三个固定入口供 Main 和委派智能体使用。新 Run 默认采用 v7 目录；已固定 v1–v6 的 Run 分别保留原 12、18、26、29、33、37 个函数。计算使用独立 Python 进程，沿用现有 Agent 的模型、任务循环和委派流程。

## 启用与按需调用

默认关闭。在 Web/App 的“设置 → 科学计算 → 管理科学环境”中启用，并填写基础 Python 与可选的独立 RDKit Python。也可通过启动环境配置：

```sh
COWORK_SCIENCE_TOOLS=1 COWORK_SCIENCE_PYTHON=/absolute/path/to/python3 atria
```

从源码运行时，将 `coworkos` 替换为 `npm start`。`COWORK_SCIENCE_PYTHON` 可省略，默认命令为 `python3`；推荐指定虚拟环境解释器的绝对路径。`COWORK_SCIENCE_CHEMISTRY_PYTHON` 为独立 RDKit 解释器，省略时继承基础 Python。对应设置保存在配置的 `science.enabled`、`science.pythonExecutable`、`science.chemistryPythonExecutable`；环境变量逐字段优先，界面锁定相应字段。

28 个函数支持 Python 3.9+，不需要第三方 Python 库，包括 3 个质谱峰/同位素函数；其余 8 个数组分析/统计函数和 4 个 RDKit 分子工具使用各自可选依赖。普通 Main 启动不自动发现 Python；科学工具初始化、设置读取、保存、搜索与说明只读取元数据，不启动 Python 或安装、下载依赖。

启用后的 Main 可以调用 `enable_tools({groups:["science"]})`，再查找和执行具体函数。用户只需提出任务，例如“计算 500 nm 光子的能量”。模型在现有推理流程中决定是否使用这些工具，不增加每次调用的人工确认。启用会话的委派智能体获得同样的三个入口；其计算分别在调用专属目录执行。未启用的普通会话没有这些工具、科学技能目录或额外基础提示词。

源码、App 后端和 CLI 共享配置及能力；设置页管理运行环境，不提供科学软件编辑器。环境路径修改只用于新任务；启用开关在后续启动会话进程时生效，当前运行的会话不即时改变。已有任务继续保留原目录和环境选择；关闭科学能力后恢复旧科学任务时，工具接口保留，计算返回不可用。

“检查基础环境”和“检查 RDKit 环境”只在点击后启动隔离 Python，检查当前未保存路径的 Python、依赖版本及最小 RDKit 样例，不会保存草稿。结果区分解释器不可用、依赖缺失或版本不符，并提供手动安装指引。基础数组依赖缺失时，标准库标量计算仍可使用；RDKit 故障不影响基础计算与普通 Agent 工具。

启用科学能力的新 Run 会在发现入口看到简短领域和任务说明。`science_search` 支持中英文任务式查询及同义表达，如“去背景后找峰”“标准曲线拟合”“dimensionality reduction”。检索只读取当前固定目录的元数据；命中后仍需 `science_describe` 核对单位、假设与输入范围。

多步实验数据和分子任务分别提供 `scientific-analysis`、`molecular-analysis` 技能，Main 与委派智能体先看到元数据，匹配时才用 `load_skill` 读取全文；简单换算无需加载。技能指导数据读取、计算选择、核验与可复现交付，仅对启用科学能力的范围提供。脚本显式使用会话说明中的固定解释器；任意 `python` 命令不会自动采用科学设置。`science_run` 仍只接收审核函数和 JSON 参数。

## 独立环境安装与复用

设置中点击“安装基础环境”或“安装分子环境”，使用所选宿主 Python 创建独立 venv，从 PyPI 下载固定版本 wheel，再运行版本及最小计算自检。支持阶段进度、取消和失败重试；关闭设置保留后台安装，应用退出会回收进程。安装成功后“使用环境”只填入草稿，“保存设置”才用于后续任务，不自动开启开关或更改现有 Run。

CLI 共用安装器和 `ATRIA_HOME` 数据根：

```sh
coworkos science status
coworkos science install general --python /absolute/path/to/python3
coworkos science install chemistry --python /absolute/path/to/python3
coworkos science cancel general
coworkos science install general --python /absolute/path/to/python3 --reinstall
```

`status` 不启动 Python 或网络请求。安装输出可用于设置或科学环境变量的解释器路径。同规格和宿主解释器的重复安装可复用已发布环境；“重新安装”及 `--reinstall` 创建新目录，自检成功才更新引用。失败、取消、中断保留此前可用环境；旧 Run 固定的环境不删除或升级。venv 不移动，已发布旧目录目前不自动回收。

环境位于 CoworkOS 数据根 `science-environments/`，与系统、项目和 App 分离。基础环境固定 NumPy 2.2.6 / SciPy 1.15.3；分子环境固定 RDKit 2026.9.1 / NumPy 2.2.6 / Pillow 11.3.0。不接受任意包或 pip 参数，不继承模型凭据、用户 pip 配置或代理。

首版需要已有 Python 3.10+、`venv` / `ensurepip` 和到 PyPI 的网络，不下载 Python 本体。固定依赖须有匹配 Python、平台和 CPU 的 wheel；缺失时失败，不改系统包或尝试源码编译。固定 RDKit 版没有 Intel Mac wheel。缺少解释器时先安装 Python 再重试，也可继续使用自备环境和手动指引。

## 已开放的计算范围

| 能力           | 函数                                                            | 输入与假设                                                                         |
| -------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 光子能量与波长 | `eV_to_nm`、`nm_to_eV`                                          | eV、nm；真空中的光子                                                               |
| 理想气体       | `ideal_gas_state`、`isothermal_process`、`isobaric_process`     | 标量；Pa、m³、mol、K；理想气体假设                                                 |
| 相变压力与温度 | `clausius_clapeyron_temperature`、`clausius_clapeyron_pressure` | Pa、K、J/mol；恒定正汽化或升华焓与理想蒸气近似                                     |
| 声压与声压级   | `convert_spl_to_pressure`、`convert_pressure_to_spl`            | RMS 有效值声压；参考 20 μPa；Pa、dB                                                |
| 声级合成       | `add_two_spl_values`                                            | 同参考值、非相干独立声源；只使用精确对数公式，`use_table` 只能为 false             |
| 距离衰减       | `calculate_spl_at_distance`                                     | 自由场点声源与正距离；`environment` 只能为 `free_field`                            |
| 光谱峰检测     | `analyze_spectrum`                                              | 至少 3 点、同长、单调递增的正波长轴；非负强度且最大值大于零；最多 8192 点、1024 峰 |

v2 目录另含下列函数：

| 能力           | 函数                    | 输入与假设                                                                                                          |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 基线校正       | `baseline_correction`   | 仅全局多项式去趋势，次数 0–5；均匀采样索引，点数须大于次数；可能移除真实宽峰                                        |
| 原始信号寻峰   | `peak_detection`        | 高度阈值和峰高为原始信号单位；可选递增坐标；峰宽为半突出度处的采样点宽度，不等同于一般的 FWHM                       |
| 线性标定       | `fit_calibration_curve` | 至少 3 对数据；仅带截距、无权重最小二乘；返回 `[斜率, 截距]`、残差、拟合值和可选预测；响应恒定时 R² 为 null         |
| 标准化 PCA     | `multivariate_analysis` | 行为样本、列为特征；2–512 行、1–64 列，总计最多 8192 单元；列按总体标准差标准化，分量数不超过 min(样本数−1, 特征数) |
| Nernst 电位    | `nernst_potential`      | 还原半反应 Ox + n e⁻ → Red；正无量纲活度、整数电子数、K、V；结果与 E0 使用同一参比电极                              |
| Bragg 晶面间距 | `bragg_law_d_spacing`   | 一级衍射；输入 2θ 为角度、严格介于 0° 与 180°；波长与结果为 Å，默认波长 1.5406 Å                                    |

一维数组最多 8192 点，寻峰最多返回 1024 个峰。多项式基线校正只拟合采样索引，不推断物理背景。PCA 的载荷符号以最大绝对载荷为正固定；重根子空间没有唯一基，结果不证明因果或化学机制。线性标定不返回 Python callable 或未经空白/噪声验证的检出限。

PCA 先减每列起始值，再对差值中心化，以保留大公共偏置下的小变化。复用标准化时使用 `((x - centering_origin) - centering_offset) / scales`，随后乘载荷转置；`means` 仅是原单位下可能发生舍入的均值摘要。

Nernst 函数采用 `E = E0 + (RT/nF) ln(a_oxidized/a_reduced)`，修正了上游与该还原电位约定相反的符号；约定依据 [IUPAC Nernst equation](https://goldbook.iupac.org/terms/view/09068)。活度不能未经说明就当作浓度。

v3 目录再加入下列天文函数，全部使用标准库，无需 Astropy、Astroquery 或星表服务：

| 能力           | 函数                           | 输入与假设                                                                                                                                                           |
| -------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V 波段消光     | `calculate_extinction`         | `e_bv` 为 0–5 mag，`rv` 为 0.1–10、默认 3.1；返回 `A_V = rv × e_bv`，单位 mag                                                                                        |
| 真距离模数     | `calculate_distance_modulus`   | `m_obs`、`M_abs`、`a_v` 为同一测光波段的星等，默认消光 0；返回 `m_obs − M_abs − a_v`                                                                                 |
| 模数转距离     | `distance_from_modulus`        | `mu` 已校正消光，范围 −10–30 mag；返回 pc，对应 0.1–10⁷ pc；不含宇宙学修正                                                                                           |
| 恒星光度       | `calculate_stellar_luminosity` | `radius` 为太阳半径，`radius_unit` 只能为 `solar`；有效温度 2000–50000 K；球形表面的总辐射光度                                                                       |
| 凌星光度与深度 | `calculate_transit_depth`      | 两个半径均为太阳半径，行星不大于恒星；同距离、同波段（或均为总辐射）的恒星与伴星光度使用相同太阳光度标度；均匀亮度、行星投影完全落入恒星盘内、暗行星，伴星光不被遮挡 |
| 小位移径向速度 | `wavelength_shift_to_velocity` | `delta_lambda`、`lambda_0` 均为 Å，`abs(delta_lambda/lambda_0) ≤ 0.001`；一阶多普勒近似，返回 m/s，正值表示远离                                                      |
| 开普勒周期     | `kepler_third_law`             | 半长轴 `a` 为 m，中心恒星质量 `M_star` 为 kg；返回 s；牛顿弱场、伴星质量可忽略                                                                                       |
| 双星质量比     | `calculate_mass_ratio_from_rv` | `k1`、`k2` 为同一双线双星拟合得到的正径向速度半振幅，单位 km/s；明确返回 `m1/m2 = k2/k1`                                                                             |

恒星光度返回含太阳光度、W、换算后的半径和温度的对象。凌星返回 `remaining_luminosity`（剩余系统太阳光度），并同时给出 `transit_depth_fraction`、`transit_depth_percent`、遮挡面积比例、损失光度和凌星前总光度；剩余光度不能当作深度。该模型不含临边昏暗、掠凌、冲击参数或随时间的光变曲线。

多普勒计算不含相对论、引力红移、宇宙学或重心修正，不适合作为精密径向速度流程。开普勒函数不验证碰撞、恒星半径或相对论适用性；数值输入通过校验不代表天体模型成立。质量比方向与常见的 `q = m2/m1` 定义相反，调用时须核对分量编号。

太阳标称单位与引力常数取值分别参见 [IAU 2015 决议](https://iauarchive.eso.org/static/resolutions/IAU2015_English.pdf) 和 [NIST 引力常数说明](https://www.nist.gov/how-do-you-measure-it/how-do-you-measure-strength-gravity)；未稀释凌星深度的面积比定义参见 [NASA HEASARC](https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/exoplanodb.html)。

v4 再加入 3 个 CoworkOS 原生 RDKit 包装函数，来源类型为 `atria-native`，不作为 SciAgentGYM 函数提取记录：

| 能力              | 函数                          | 输入与结果                                                                                            |
| ----------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| SMILES 校验       | `rdkit_validate_smiles`       | 解析并净化分子，返回 `valid: true`、规范 SMILES、图原子数、重原子数、形式电荷和版本；无效输入返回错误 |
| SMILES 规范序列化 | `rdkit_canonicalize_smiles`   | 返回 RDKit canonical isomeric SMILES 和版本，保留其支持的同位素与已给定立体信息                       |
| 二维分子描述符    | `rdkit_molecular_descriptors` | 净形式电荷须为 0；返回 MolWt（g/mol）、Wildman–Crippen logP、Lipinski HBD/HBA 和 N/O 模型 TPSA（Å²）  |

三个函数均只接收 `smiles` 字符串，长度 1–2048 个 ASCII 字符、无空白，且最多 256 个输入图原子（含显式氢）。仅接受由 H、B、C、N、O、F、Si、P、S、Cl、Br、I 组成的单连通闭壳层分子；同位素标记只接受 RDKit 质量表有记录的编号。原子括号内的显式氢计数及形式电荷幅度均不得超过 8，数值和重复符号写法都会先检查，避免解析器截断。拒绝盐与混合物、原子映射、查询/虚原子、自由基及非共价扩展。返回的 `atom_count` 在移除普通显式氢之后计数，不包含隐式氢，同位素氢保留。

校验成功只表示 RDKit 能在当前范围内解析和净化结构。规范 SMILES 依赖工具及版本，不是通用化学身份；不选择质子化状态、不合并互变异构体、不去盐或中和电荷。描述符允许净电荷为零的电荷分离表示；MolWt 不是单同位素精确质量，logP 是结构估计而非实测值或 pH 相关 logD，TPSA 不是三维表面积。定义见 [RDKit Book](https://www.rdkit.org/docs/RDKit_Book.html) 与 [Crippen 文档](https://www.rdkit.org/docs/source/rdkit.Chem.Crippen.html)。

v5 再加入 4 个材料计算函数，只使用标准库和基础 Python 环境：

| 能力                | 函数                                    | 输入与假设                                                                                                              |
| ------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 立方晶格参数        | `cubic_lattice_parameter`               | `d_spacing` 为 Å，`hkl` 为不全为零的 3 个整数；`a = d × sqrt(h²+k²+l²)`，返回 Å；只适用立方晶系                         |
| 直接晶格度规        | `calculate_metric_tensor`               | `a,b,c` 为 Å，`alpha,beta,gamma` 为度；返回 `metric_tensor`（3×3，Å²）与 `volume_angstrom3`（Å³）；只接受非退化正定晶胞 |
| 一般晶面间距        | `calculate_interplanar_spacing_general` | `h,k,l` 为不全为零的整数，`metric_tensor` 为对称正定的 3×3 直接度规（Å²）；返回 Å；倒易度规不含 2π 因子                 |
| Scherrer 相干畴估计 | `calculate_scherrer_grain_size`         | 峰位与 FWHM 均为 2θ 轴上的度；波长为 nm，默认 0.15406；形状因子默认 0.9；返回尺寸 nm                                    |

晶格边长与 `d_spacing` 的数值预算为 10⁻⁶–10⁶ Å，Miller 指数为 −1000–1000 的整数且不全为零，不约去公因子；角度为 0.001°–179.999°。度规输入严格为对称 3×3 矩阵、元素绝对值不超过 10¹² Å²、对角元素至少 10⁻¹² Å²。Cholesky 正定检查与条件数检查会拒绝病态或近退化输入，包括无穷范数条件数大于 10¹⁰ 的矩阵；这些是数值预算，不保证材料在物理上存在。

度规的晶格角 `alpha` 位于 b/c 间、`beta` 位于 a/c 间、`gamma` 位于 a/b 间。单个角分别处于 0°–180° 仍不足以保证有效晶胞，必须共同形成正定度规。晶格和间距计算只给出几何关系，不进行衍射峰索引、系统消光判断、物相鉴定或晶体结构求解。

Scherrer 使用 `D = K × wavelength_nm / (beta_rad × cos(theta))`，其中 `theta = peak_2theta_deg / 2`。注意其波长和尺寸单位为 nm，而 Bragg 和晶格几何使用 Å，`1 nm = 10 Å`。本版本明确采用 Gaussian 展宽模型：`beta_rad = sqrt(fwhm_deg² − instrument_fwhm_deg²) × pi/180`，要求测得 FWHM 大于非负仪器 FWHM；不使用上游未声明峰形的直接相减。该模型不适用于未经转换的 Lorentzian/Voigt 去卷积，也不分离应变、缺陷或其他展宽贡献。结果为沿该反射方向的相干衍射畴尺寸估计，不能当作颗粒尺寸或晶粒尺寸的直接测量。通用寻峰返回的半突出度采样点宽度也不能直接用作此处 2θ 轴上的角度 FWHM。

Scherrer 峰位预算为 0.001°–179.999°、测得 FWHM 为 10⁻⁶–10°、波长为 10⁻⁶–100 nm、形状因子为 0.1–2。校正方差与测得方差之比不超过 10⁻¹² 时拒绝近乎完全相消的输入。结果对象包含 `D_nm`、`theta_deg`、`beta_rad`、`corrected_fwhm_deg` 和固定的 `instrument_model: "gaussian"`。

度规约定与尺寸展宽限制参见 [IUCr 倒易晶格教材](https://www.iucr.org/what-we-do/education/pamphlets/reciprocal-lattice) 与 [IUCr Scherrer 方程讨论](https://journals.iucr.org/j/issues/2024/05/00/oc5037/index.html)。例如立方晶胞 `a=b=c=4 Å`、三角均为 90°，得到对角值均为 16 Å² 的度规；将它与 `(h,k,l)=(2,0,0)` 传入一般间距函数得到 `d=2 Å`，再以该间距和 `hkl:[2,0,0]` 反算得到 `a=4 Å`。

v6 再加入下列质谱工具，环境设置继续使用原有基础 Python 与 RDKit Python：

| 能力                | 函数                                    | 输入与结果                                                                                                                                                                |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 质谱峰筛选          | `parse_mass_spectrum_peaks`             | 严格递增的正 `mz_values` 与同长非负 `intensities`；先按基峰归一到 100，再按 `intensity_threshold`（默认 1）包含边界地筛选；返回原始/相对强度、基峰与保留峰中的最高 m/z 峰 |
| Cl/C 名义同位素分布 | `calculate_theoretical_isotope_pattern` | 真整数 `num_chlorine:0–16`、`num_carbon:0–128`（默认 0）；分别返回各名义质量偏移箱的概率和基峰 100 相对强度                                                               |
| 已知电荷候选峰簇    | `find_isotope_cluster`                  | `peak_mz`、`peak_intensity`、`base_mz`；已知 `abs_charge:1–10`（默认 1），`mass_tolerance` 默认 0.05 m/z；查找 M/M+2/+4/+6 的名义间距候选                                 |
| 精确质量与分子式    | `rdkit_exact_mass_and_formula`          | CoworkOS 原生包装；有限 `smiles`，净形式电荷为 0；返回 `canonical_smiles`、保留同位素标记的 `formula`、`exact_mass_da` 和 `rdkit_version`                                 |

输入必须是已质心化的峰列表，不接受将连续 profile 自动寻峰或质心化的请求。峰数组均限 1–8192 点，m/z 与 `base_mz` 的数值预算为 10⁻¹⁰⁰–10⁶，原始强度不超过 10¹⁰⁰ 且最大值须为正。峰筛选保留超过 1024 个时返回 `result_too_large`，不静默截断；相对强度是原始最大强度的百分数，不是概率。`highest_mz_peak` 仅表示保留峰中的最大 m/z，不能当作分子离子峰；基峰也不能据此判定分子身份。

同位素模型对独立的 ³⁷Cl 与 ¹³C 计数做真实二项卷积，以 `j + 2k`（j 个 ¹³C、k 个 ³⁷Cl）合并名义质量偏移，包含 0 到 `num_carbon + 2 × num_chlorine` 的全部箱（含零概率箱，最多 161 个）。`probability` 是概率，`relative_intensity` 按最大箱归一到 100；两者含义不同。固定丰度 `p(³⁷Cl)=0.2424`、`p(¹³C)=0.0107` 随结果记录，参考 [NIST 氯](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=Cl) 与 [碳](https://physics.nist.gov/cgi-bin/Compositions/stand_alone.pl?ele=C)。这是仅 Cl/C 的名义质量数模型，不含其他元素同位素、精确同位素质量差或高分辨精细结构；自然丰度会随样品变化，参见 [CIAAW 氯](https://ciaaw.org/chlorine.htm) 与 [碳](https://www.ciaaw.org/carbon.htm)。

峰簇函数要求 m/z 严格递增，容差为 10⁻⁶–0.25 m/z 且小于 `0.5/abs_charge`。先在 `base_mz` 附近寻找观测 M，再以该观测值为锚点、按 `2/abs_charge` 的名义步长匹配其余峰；任何窗口有多个候选直接返回 `ambiguous_match`。结果保留请求锚点、实际 M、匹配位置/偏差、缺失标签和电荷参数。缺 M、缺 M+2 或 M 强度为零时比值为 null；这些匹配不证明共同同位素来源，不据此推断氯原子数、电荷态、分子离子或结构，也不做高分辨精确质量匹配。

原生精确质量工具使用同一固定 `rdkit==2026.9.1` 环境及已有单分子输入限制；不会修改旧 RDKit 工具。它计算所给净电荷为零结构的 RDKit `ExactMolWt`（Da），不是平均分子量 MolWt，也不自动计算带电离子、加合物或实验 m/z。未标记原子采用 RDKit 的最丰同位素质量约定，显式同位素标记保留。公式与质量定义见 [RDKit ExactMolWt](https://www.rdkit.org/docs/source/rdkit.Chem.Descriptors.html#rdkit.Chem.Descriptors.ExactMolWt) 和 [CalcMolFormula](https://www.rdkit.org/docs/source/rdkit.Chem.rdMolDescriptors.html#rdkit.Chem.rdMolDescriptors.CalcMolFormula)。

v7 加入 3 个 CoworkOS 原生统计函数，复用基础 NumPy/SciPy 环境，无新增依赖：

| 能力           | 函数                     | 契约                                                                                                                          |
| -------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 数值摘要       | `summarize_numeric_data` | 1–8192 个有限数；返回均值、中位数、线性插值四分位数、样本方差/标准差；单样本的方差/标准差为 null 并说明原因                   |
| 线性相关       | `pearson_correlation`    | 等长的两组配对数据，各 3–8192 个；返回 r 与零总体相关假设下的双侧 p 值，拒绝常数及近常数输入                                  |
| 独立组均值比较 | `welch_t_test`           | 两个同单位的独立样本，各 3–8192 个且具有可解析的正方差；返回均值差 A−B、Welch t、自由度、双侧 p 值及均值差的固定 95% 置信区间 |

输入不允许布尔、缺失值、NaN 或 Infinity，绝对值上限为 10¹⁰⁰；不自动删失数据或选择检验。四分位数使用 Hyndman–Fan type 7，样本方差使用 `ddof=1`；见 [NumPy quantile](https://numpy.org/doc/2.2/reference/generated/numpy.quantile.html)。偏移/缩放计算降低大偏移和小尺度的数值误差，不可表示的非零结果返回 `numeric_range`。Pearson 在 `|r| ≥ 1−10⁻¹²` 时仅接受精确输入可证明的仿射线性关系，其余返回 `numeric_range`；非精确线性得到零 p 值时也保守拒绝，避免把舍入误报为概率下溢。Welch 极小 p 值下溢为零时返回显式标志与说明。

相关和均值检验要求观测独立；Pearson 的解析 p 值具有零相关下的正态模型假设，Welch 小样本推断要求总体近似正态。这些前提不能仅凭数组确认；配对、重复测量和时间序列不能直接当作独立组。工具不作自动显著性决定；相关不等于因果，p 值不是原假设为真的概率，也不是效应大小。详见 [SciPy Pearson](https://docs.scipy.org/doc/scipy-1.15.3/reference/generated/scipy.stats.pearsonr.html) 与 [Welch t 检验](https://docs.scipy.org/doc/scipy-1.15.3/reference/generated/scipy.stats.ttest_ind.html)。

先用 `science_describe` 读取参数、单位、默认值、适用条件、示例和来源。参数按函数单独验证，不允许额外字段、表达式、模块路径或执行选项。光谱强度按最大值归一化；峰宽单位为采样点，未计算时为 null。峰检测不进行基线校正、化学识别或物理机制推断。

示例调用：

```json
{ "name": "eV_to_nm", "arguments": { "energy_eV": 2 } }
```

此对象是 `science_run` 的参数，结果约为 619.92 nm。结果同时返回单位、假设和固定上游来源，不能将工具的数值输出扩大解释为超出模型假设的科学结论。

## 实验数据调用示例

用户文件可以沿用现有 `read` 工具读取，将有限数组传入科学工具，再由普通文件工具保存结果。例如对标准曲线调用 `science_run`：

```json
{
  "name": "fit_calibration_curve",
  "arguments": {
    "concentrations": [0, 1, 2, 3],
    "responses": [1, 3, 5, 7],
    "predict_at": [1.5]
  }
}
```

返回斜率约 2、截距约 1、预测响应约 4，同时包含拟合与误差信息。科学接口直接接收 JSON 数组并返回数值；文件读取、保存和图表制作继续使用 Agent 的已有能力。

天文任务也可连续调用。例如 `calculate_extinction({e_bv:0.2})` 得到 `A_V = 0.62 mag`，将其作为 `calculate_distance_modulus({m_obs:10.62,M_abs:5,a_v:0.62})` 的消光得到 `mu = 5 mag`，再调用 `distance_from_modulus({mu:5})` 得到 `100 pc`。这些对象分别放在 `science_run` 的 `arguments` 中；应由用户或已有测量提供同波段星等和消光假设。

## 可选数值依赖

`baseline_correction`、`fit_calibration_curve` 和 `multivariate_analysis` 需要 NumPy；`analyze_spectrum` 与 `peak_detection` 需要 NumPy 和 SciPy。PCA 不额外依赖 pandas 或 scikit-learn。可在单独的 Python 3.10+ 虚拟环境中安装验证使用的版本：

```sh
python3 -m venv .tools/science
.tools/science/bin/python -m pip install numpy==2.2.6 scipy==1.15.3
COWORK_SCIENCE_TOOLS=1 COWORK_SCIENCE_PYTHON="$PWD/.tools/science/bin/python" npm start
```

以上是源码检出的示例，不会自动执行。固定依赖清单随运行器复制到 `dist/src/tools/science/requirements.txt`。缺少依赖时，仅相应数组分析返回依赖缺失错误，标量和普通 Agent 工具继续可用。科学依赖不随 App 捆绑；可使用设置或 CLI 安装器显式安装，也可自备环境。Mac 包内 CAD/Blender 运行时由各自组件维护；科学工具使用 `COWORK_SCIENCE_PYTHON` 选择的解释器，省略时使用 `python3`。

RDKit 推荐单独使用 Python 3.10+ 环境，避免与基础数组环境相互升级。v4 固定 `rdkit==2026.9.1`（运行时版本 `2026.09.1`）、`numpy==2.2.6`、`Pillow==11.3.0`，清单为 [requirements-chemistry.txt](../src/tools/science/requirements-chemistry.txt)：

```sh
python3 -m venv .tools/science-rdkit
.tools/science-rdkit/bin/python -m pip install rdkit==2026.9.1 numpy==2.2.6 Pillow==11.3.0
```

在设置中将 RDKit Python 指向该环境解释器的绝对路径，或设置 `COWORK_SCIENCE_CHEMISTRY_PYTHON`。Windows 使用环境内的 `Scripts/python.exe`。该 RDKit 发行提供 macOS arm64、Linux 和 Windows wheel，未提供 Intel Mac wheel；不同 RDKit 版本会返回 `dependency_version_mismatch`，不会静默降版。分发文件见 [PyPI 2026.9.1](https://pypi.org/project/rdkit/2026.9.1/)。例如 `science_run({name:"rdkit_canonicalize_smiles",arguments:{smiles:"OCC"}})` 返回 `CCO`；对 `CCO` 调用分子描述符得到 MolWt 约 46.069 g/mol。

## 执行与恢复

每次计算启动独立进程组，使用调用专属目录、最小环境和 `-I` 隔离模式，不继承模型密钥、代理或用户 Python 路径。不在 Agent 主进程导入上游。仅执行当前固定目录内的离线函数，不加载上游 Agent、全目录工具、联网查询或任意 Python 代码。

请求与输出各有 1 MiB 限制，默认运行时限为 30 秒；输入规模和数值边界由各函数校验。取消、超时、输出超限和异常会结束对应进程组，并返回 `isError`，不关闭 Agent。独立进程是执行生命周期边界，不代表对现有 bash/jobs 或整个应用提供 OS 沙箱。

首次启用的 Run 在自己的 `science-tools.json` 中固定目录版本与基础/化学解释器选择；同一 Run 不会因为启动变量或设置路径变化而静默切换实现。委派队列也保存该选择。重启时关闭科学开关，原 Run 仍保留固定工具接口供请求恢复，但计算返回不可用；新 Run 不出现科学入口。损坏或不支持的记录保留原样，仅使科学能力不可用。

支持 `sciagentgym-e9dbbea-pilot-v1`（12 个）、`sciagentgym-e9dbbea-analysis-v2`（18 个）、`sciagentgym-e9dbbea-astronomy-v3`（26 个）、`atria-rdkit-chemistry-v4`（29 个）、`sciagentgym-e9dbbea-materials-v5`（33 个）、`sciagentgym-e9dbbea-mass-spec-v6`（37 个）和 `atria-statistics-v7`（40 个）七个目录。v1–v6 的参数、说明和 Python 实现保留原样，旧目录不能搜索或执行之后新增的函数。Dashboard 手动重试即使创建新 Run ID，也继承原目录与解释器；原请求未启用科学工具时，重试仍保持该范围。继承遇到冲突或无法读取的记录会保留原请求并拒绝这次启动，避免换成新的执行环境。

当前计算无外部副作用，未提供持久长作业或跨进程崩溃的恰好一次执行保证。模型请求重试和 Agent checkpoint 继续使用现有机制；量子计算、外部程序与联网工具后续单独设计生命周期。

## 来源与开发入口

33 个适配函数来源固定为 [SciAgentGYM e9dbbea](https://github.com/CMarsRover/SciAgentGYM/tree/e9dbbea4369d67694e38bf8be67bedbcaf9e9300)。只提取并适配这些函数，移除了绘图、文件写入和模块导入副作用，补充单位、输入边界、稳定数值计算和 JSON 序列化。来源行号和文件哈希随目录返回；许可与修改说明见 [LICENSE](../vendor/sciagentgym/LICENSE)、[NOTICE](../vendor/sciagentgym/NOTICE)。4 个 RDKit 包装与 3 个统计函数为 CoworkOS 原生实现，其来源记录提供本地实现路径、实现版本与对应库文档，区别于上游提取记录。

- [版本目录](../src/tools/science/catalog.ts)、[天文目录](../src/tools/science/astronomy-catalog.ts)、[分子目录](../src/tools/science/chemistry-catalog.ts)、[统计目录](../src/tools/science/statistics-catalog.ts)、[执行服务](../src/tools/science/service.ts)、[固定工具](../src/tools/science-tools.ts)
- [Run 配置](../src/runtime/science-config.ts)、[环境配置与自检](../src/runtime/science-environment.ts)、[设置控制器](../web/assets/controllers/science-settings.js)、[Main 装配](../.pi/runtime/tools/science.ts)、[Python 运行器](../src/tools/science/runner.py)
- [首批数值](../test/science-kernels.test.js)、[实验分析数值](../test/science-analysis.test.js)、[天文数值](../test/science-astronomy.test.js)、[RDKit 数值](../test/science-chemistry.test.js)、[统计数值](../test/science-statistics.test.js)、[服务检查](../test/science-tools.test.js)、[配置检查](../test/science-config.test.js)、[真实 Pi](../test/science-pi.test.js)、[Dashboard 重试与数据流程](../test/science-main-retry.test.js)、[设置浏览器流程](../e2e/science-settings.spec.js)

扩展时先增加具体函数的已知答案、单位和失败测试，再加入固定目录；不要将上游某个学科目录直接全量开放。新增依赖保持可选。关闭能力时，应继续验证普通任务的工具 schema、默认提示词和技能目录不变。
