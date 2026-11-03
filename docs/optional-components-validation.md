# 可选组件验收记录

本页保留基础包与按需组件实现各来源快照的历史执行证据；尚未运行的项目不算通过。当前默认桌面发行内置 PPT 编辑器，首次启动后自动准备 CAD/Blender，入口统一到“设置 → 应用与组件”。下文旧基础包与仅含 CAD/PPT 的完整包测量不适用于当前默认小包；新包重制、安装、签名和第三方分发审阅须单独记录，见 [应用与组件](optional-components.md)。

## 确定性工程验证

- `node node_modules/typescript/bin/tsc -p tsconfig.json`：通过。
- `node --test test/components.test.js`：真实本地 HTTP、tar 解包和文件激活；12 项通过，无 skip。覆盖并发复用、跨宿主升级识别、停用/启用/卸载保留文档、校验失败/网络错误/不兼容版本保旧、跨服务取消/重试、空间不足门槛、已有环境复用、受管路径符号链接拒绝、HTTP/Origin 边界、dead-owner 锁恢复、portable PPT、损坏 JSON 标量恢复与逃逸符号链接拒绝。空间不足使用注入的零可用字节数，未填满机器磁盘。
- `node --test test/components.test.js test/release-artifacts.test.js test/blender-installer.test.js`：29 项通过，无 skip，包含真实 macOS 小型 DMG 安装夹具；不等于官方 Blender 完整下载验收。
- `node --test test/components.test.js test/release/runner.test.mjs`：15 项通过，无 skip（早期 6 项组件夹具时执行）。
- `node --test test/components.test.js test/release-artifacts.test.js test/release/runner.test.mjs`：36 项通过，无 skip（组件 11 + 发行 16 + runner 9）。后续新增发行组件清单校验用例，`test/release-artifacts.test.js` 17 项通过。

## 体积测量与入口验收

本机 Apple Silicon Mac 实测；开发候选来自基准 HEAD `5d98b6920ad1ab98588fa2770c109babf2cdec7a` 加当前未提交实现，不是最终冻结/tag 发行产物。下表使用文件逻辑字节与真实压缩大小，磁盘块占用另记，不能以包中 HEAD 字段替代工作树来源证明。

| 产物                |      压缩/下载字节 |  安装逻辑字节 | 验证                                                             |
| ------------------- | -----------------: | ------------: | ---------------------------------------------------------------- |
| 基础 CLI            |         38,586,611 |   171,026,106 | 独立 prefix `npm install` + 真实 Pi 主/子智能体与文件/恢复       |
| 基础 App            | 172,349,885（DMG） |   418,057,326 | `build:base` + 独立签名候选启动/任务/重启恢复                    |
| 完整 App            | 454,799,568（DMG） | 1,361,997,195 | `desktop:dist:full` + ad-hoc strict 签名与 `hdiutil verify`      |
| CadQuery 独立组件   |        245,139,442 |   931,883,723 | 实际归档本地 HTTP 下载/校验/解包、Python 2.6.1 固体有效、体积 24 |
| PPTist 独立组件     |          2,118,475 |     5,685,710 | 实际归档 HTTP 安装，入口与 AGPL 许可/对应源码保留                |
| Blender 官方 4.5.11 |        308,255,028 |   822,731,075 | 官方完整下载/固定 SHA/真实 DMG 安装、background 创建 cube        |

CAD 实际首次冷安装 98.8 秒，PPT 0.07 秒；Blender 下载与安装 64.3 秒。三项组件停用、启用和卸载后临时用户文档仍保留。Blender 的8倍下载磁盘预算只是保守安装门槛，表内安装字节由真实文件测量。完整 App 中 CAD 为 935,189,743 字节（打包签名后），PPT 为 5,685,710 字节；最终基础/完整候选使用同份编译源码逐文件比较，App 减少 943,939,869 字节（69.31%），DMG 减少 282,449,683 字节（62.10%）；差額精确归属 CAD 935,189,743 + PPT 5,685,710 + 父 App 签名资源清单 3,064,416 字节，其他文件没有大小差额。完整 DMG 只读挂载核对后已卸载。完整 App 磁盘块占用 `du -sk` 为 1,424,520 KiB；基础为 440,980 KiB；CLI 独立安装为 227,828 KiB。

源码基础真实 Pi：`node --test test/components-base-pi.test.js` 1 项通过（2.4 秒），本地假模型 + 真实 Main/子智能体 + 文件操作 + 持久会话重启恢复；显式缺失 CAD/Blender，组件临时目录始终为空。

独立 CLI 候选的 `TEST_ATRIA_CLI_ROOT=... node --test test/components-base-pi.test.js`：1 项通过，2.6 秒，无 skip。实际基础 App 的 `ATRIA_DESKTOP_APP=... playwright test e2e/optional-components-desktop.spec.js --workers=1`：签名前 1 项通过（7.8 秒），ad-hoc 签名后 1 项通过（5.3 秒），最终同快照候选再通过（8.8 秒），含应用面板可选组件可见入口、本地模型任务、关闭/重开持久恢复、基础包无 CAD/PPT 和空组件目录。

`playwright test e2e/optional-components.spec.js --workers=1`：1 项通过（2.5 秒），实际浏览器管理模块调用真实 Dashboard + 本地 HTTP/tar 安装服务，哈希失败→重试→激活→停用/刷新→启用→卸载，用户文档保留。

执行中首次真实 CAD 安装发现 setuptools 合法空格文件名被安全规则拒绝，修正后真实安装与12项边界回归通过。基础 App 夹具首次未等待模型/项目状态稳定导致未发送任务；添加可见状态等待后通过。增加应用入口检查时首次使用工作台收起按钮而非应用面板 toggle，修正真实 toggle 后通过。这些初次失败未算通过。

最终另一台干净 Mac 的下载隔离属性、签名/公证、真实系统授权、真实模型账户与旧正式包升级：未执行，仍是发行验收。

最终测量后仅追加验收文档与测试证据，没有改变被测产品源码；CLI 归档内的验收文档是打包当时版本。正式发布需冻结提交后重新制作带该提交来源证明的发行产物。

被测产品变更文件（路径与内容 SHA-256 聚合）的快照标识：`b8fe8388e9af02a1a4cfaf7836d1d26c7ebf2f433689e5b6763f5921119e3087`。测试和验收文档随后记录执行证据，不改变被测产品代码。

最终 `npm run check:ci` 全项通过；`node --test test/components.test.js test/release-artifacts.test.js test/release/runner.test.mjs test/repository-checks.test.js` 44 项通过，0 fail / 0 skip；`git diff --check` 通过。完整 `verify` 由最终整合与独立复审阶段执行，此处不宣称已通过。

## 独立复审后修复

PR44 独立复审指出显式外部运行时被受管状态掩盖、同版本损坏无法修复。修复后 `node --test test/components.test.js` 14/14 通过（0 skip）：真实 HTTP/tar 同版损坏修复、hash 失败保旧、并发单下载、重启识别、同版升级和失败保其他可用版本/文档；实际外部可执行 stub（CAD 2.5.2 / Blender 4.4.3）与 consumer 选择一致，失效外部路径即时撤销 available 并拒绝假修复，撤销覆盖恢复受管选择。第一次新增测试夹具误用了不存在的 bad-hash 模式、将 macOS /var 与 /private/var 当不同路径，已修正并重跑通过。

本轮产品源码修改安装服务，因此上面的包体/候选生命周期属于前一产品快照的历史证据；不能宣称这些候选包含本轮修复。最终候选重制、Pi/浏览器/原生重跑另排资源窗口；当前仅 tsc emit、轻量 Node 和静态检查。

本轮最终 `node --test test/components.test.js test/release-artifacts.test.js test/release/runner.test.mjs test/repository-checks.test.js`：46 pass / 0 fail / 0 skip；tsc emit、修改文件 ESLint/Prettier、docs/source 检查与 diff whitespace 均通过。未运行 check:ci 的 build 部分或 Pi/browser/原生/包体重制，以遵守独占资源窗口。

## 2026-10-15 设置入口与默认完整包调整

本节记录当时的完整包方案：组件入口统一到“设置 → 应用与组件”，该阶段默认桌面打包包含 CadQuery/Python、Blender 与 PPT 编辑器。electron-builder 通过 `atriaBundledComponents` 标记完整交付模式，路径选择由 `packagedComponentDirectory` / `selectedComponentDirectory` 统一：完整包优先内置组件，缺失时提示修复，不回退旧用户版本；开发/CLI/内部基础包继续优先受管安装，显式 CAD/Blender 覆盖仍优先。以下是本次源码修改的分阶段执行记录，不是冻结 DMG 的发行验收。

- TypeScript 编译、`lint`、`check:workbench`、`check:extensions` 与 `check:source` 已通过。
- 整合阶段 `node --test test/workbench-ui.test.js test/components.test.js test/desktop-component-auth.test.js`：52/52 通过。随后组件服务新增本地探测回归，此计数属于新增用例前的运行，最终整合计数另记，不能据此声称新增用例已通过。
- 包装回归 `node --test test/desktop-components-packaging.test.mjs test/desktop-runtime-packaging.test.js test/package-components.test.mjs`：初始组合运行 7/7 通过，验证默认完整包资源、许可材料门槛与打包准备行为。随后新增路径优先级测试，最终结果另记；此前计数不是新增用例或实际 DMG 构建、签名、搬移后原生执行的证明。
- 最终整合 `node --test test/workbench-ui.test.js test/components.test.js test/desktop-component-auth.test.js test/component-entry.test.js test/cad-empty-close.test.js test/desktop-components-packaging.test.mjs test/desktop-runtime-packaging.test.js test/package-components.test.mjs test/desktop-backend.test.js`：71/71 通过，无 skip。中途一次 69 项运行有 1 项失败，原因是内置路径夹具尚未写入新 package metadata 标记；修正夹具、重新编译并新增回归后完成本次最终运行。最新包装三文件组合 8/8、后端与组件组合 23/23 通过。
- 浏览器 `e2e/component-layout.spec.js`、`e2e/settings-design.spec.js`、`e2e/optional-components.spec.js` 首轮 7/9 通过，另两项超时。使用 `--workers=1 --grep 'repair guidance|real HTTP installation'` 对两项复测，2/2 通过；保留首轮超时记录，不把首轮写为全部通过。
- 最新设置/管理浏览器共 9/9 分批通过：`settings-design` 3/3 与 `optional-components` 1/1 在最新串行套件通过；`component-layout` 使用 `--workers=1 --output=/tmp/atria-component-layout-keyboard-final` 最终 5/5 通过。中途串行套件曾 8/9 通过，`repair guidance` 在 Playwright 等待重检按钮稳定时超时；trace 显示等待后才发起状态探测，未出现产品或服务错误。重检用例补键盘 Enter 操作后通过，上方主流程保留鼠标启停与修复覆盖。
- 原生 `e2e/component-auth-desktop.spec.js`：1/1 通过。该测试验证内部凭据兼容路径，不表示普通设置仍提供凭据输入，也不代替最终安装包验收。
- 入口回归 `node --test test/component-entry.test.js test/cad-empty-close.test.js`：5/5 通过；入口相关 ESLint 通过。
- 入口浏览器 `node_modules/.bin/playwright test e2e/blender-install.spec.js e2e/component-entry.spec.js --workers=2 --output=/tmp/atria-component-entry-e2e`：该阶段 7/7 通过（16.2 秒），包括缺失按钮定位设置、保留修复重试，以及 PPT 修复后加载真实编辑器并保存。首次静态页夹具缺少 UTF-8 charset；真实 PPT 缺失页暴露加载遮罩覆盖按钮，已用既有 iframe channel 的 `component-unavailable` 消息修复；关闭验收最初误点隐藏入口，改用可见的文件关闭入口。修正后重跑通过；此后又增加未回写源文件的关闭保护和设置面板关闭后的启停通知修正，最新专项结果另记。
- 随后补充 PPT 关闭保护：iframe 组件不可用时，仅在没有文稿草稿、待提交操作及 `sourcePending` 时允许安全关闭，原文件尚未回写仍拒绝关闭。新增专项在修复前复现 `expected false / received true`，修复后 `node_modules/.bin/playwright test e2e/component-entry.spec.js --grep='PPT workbench|source file has unsaved changes' --workers=1 --output=/tmp/atria-ppt-source-guard-after-serial`：3/3 通过（13.4 秒），覆盖待回写时拒绝关闭、`savedRevision=revision` 后可关闭，以及原缺失关闭与修复后真实编辑器加载。首次修复后并行运行的另两项在 Dashboard 启动阶段、尚未页面导航时超时；最终串行重跑通过。Adapter ESLint 与 Adapter/测试 Prettier 通过。此专项是前述 7/7 后的追加验证，不扩称全部入口在最新源码上重跑。
- 最后修正组件设置关闭生命周期：关闭面板只取消状态 GET，不取消已提交的启停 POST；操作完成后仍通知打开的编辑器刷新组件状态。新增关闭后启用回归，`node_modules/.bin/playwright test e2e/component-layout.spec.js --workers=1 --output=/tmp/atria-component-layout-lifecycle-final`：最终 6/6 通过（20.5 秒）。结合最新 `settings-design` 3/3 与 `optional-components` 1/1，设置/管理浏览器最终共 10/10 分批通过。最终 manager/PPT Adapter ESLint、对应四文件 Prettier 与 `git diff --check` 通过；这两项安全修正后无剩余产品代码改动。

本次尚未重制包含全部组件的 DMG，也未验证新完整包的干净安装、签名/公证或搬移后真实 CAD/Blender 执行；第三方对应源码与分发审阅仍需单独完成。此前的基础包、仅内置 CAD/PPT 的完整包和独立 Blender 下载结果不能替代这些检查。普通 App 用户不依赖私有仓库下载凭据，该阶段的缺失组件按钮打开完整包修复说明，尚未开放自动下载。
