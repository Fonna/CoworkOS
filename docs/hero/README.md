# CoworkOS README 头图 / README hero

## 中文

独立 React + SVG 头图工程。`CoworkOS` 使用参考图风格的原创粗体几何路径，左侧是矢量重绘的品牌 Logo，右侧是用代码提炼的桌面应用左上角。右侧组件不引用产品截图。

选框参考 [React Bits Tech Text](https://www.reactbits.dev/text-animations/tech-text)，用本地 [TechText.jsx](TechText.jsx) 独立实现，未复制上游组件源码。`Cowork` 完全静止；只有 `OS` 在蓝色与淡紫色之间连续渐变，始终实心且不改变透明度。选框固定在 `OS`，两组亮点带尾迹沿框缓慢绕行，周围方粒子保持静止，不闪烁、不重生。动画每 6 秒平滑循环。窗口向右留出间距，同时收紧侧栏宽度和行距，保留品牌、导航、`Long-term tasks` 与项目区。主区域为简短的示意对话，文字完整落在可见范围内，不显示欢迎语或重复 Logo；窗口使用经典红黄绿圆点。

### 预览与导出

```sh
cd docs/hero
npm ci
npm run preview
```

预览地址为 `http://127.0.0.1:18742`。`?time=3.25` 固定动画时间，`?static=1` 显示静态矢量场景；系统启用“减少动态效果”时默认静态。预览按钮可切换播放与静态。

首次导出需准备 Chromium 和 Pillow：

```sh
npx playwright-core install chromium
python3 -m pip install Pillow
```

```sh
npm run render
python3 encode.py ../../.tmp/readme-tech-frames
```

导出 **1440 × 480、6 秒、20 fps** 的循环 GIF 和同尺寸静态 PNG，更新 [readme-hero.gif](../assets/readme-hero.gif) 与 [readme-hero.png](../assets/readme-hero.png)。中英文 README 共用这两张图。渲染器直接采样 120 帧，编码器使用共享调色板；帧与检查用的 `contact.png` 保留在 `.tmp/readme-tech-frames/`。颜色与边框亮点在循环首尾连续衔接。

### 编辑入口

- [scene.jsx](scene.jsx)：画布、Logo 与应用窗口位置、播放时钟。
- [TechText.jsx](TechText.jsx)：专为 `CoworkOS` 绘制的字形、颜色渐变与固定 `OS` 框；不是通用字体组件。
- [Logo.jsx](Logo.jsx)：按提供的品牌图重绘的蓝紫色矢量路径。
- [HarnessCorner.jsx](HarnessCorner.jsx)：窗口栏、导航和任务区的艺术化提炼。
- [render.mjs](render.mjs)、[encode.py](encode.py)：确定帧导出、GIF 编码与循环校验。

预览构建输出到 `.tmp/readme-hero/`；依赖隔离在本目录，不接入产品运行时。界面小字复用仓库的 Inter 字体。旧版 ElectricLogo 源码、许可和 [来源记录](react-bits/SOURCES.md) 仍保留在 `react-bits/`，当前场景不导入它。

## English

A standalone React + SVG hero with original geometric `CoworkOS` letterforms, a vector reconstruction of the supplied ribbon logo, and an illustrated upper-left corner of the desktop harness. The application illustration is code, with no embedded product screenshot.

The fixed selection frame is inspired by [React Bits Tech Text](https://www.reactbits.dev/text-animations/tech-text), implemented independently in [TechText.jsx](TechText.jsx) without copying upstream source. `Cowork` stays completely static. Only `OS` smoothly changes between blue and lilac, with constant opacity and solid geometry. Two packets with short trails travel around the fixed frame; surrounding specks stay still, with no blinking or respawning. The animation loops every six seconds. The window shifts right without lowering it; a narrower sidebar and tighter row spacing keep the brand, navigation, `Long-term tasks` and project area visible. The main area contains a short illustrative conversation with complete visible lines, without a welcome heading or duplicate logo. Controls use classic red, yellow and green.

### Preview and export

```sh
cd docs/hero
npm ci
npm run preview
```

Open `http://127.0.0.1:18742`. Use `?time=3.25` for a deterministic frame or `?static=1` for the static vector scene. Reduced-motion preferences select the static scene by default; the preview button toggles playback.

Install Chromium and Pillow once:

```sh
npx playwright-core install chromium
python3 -m pip install Pillow
```

Then export:

```sh
npm run render
python3 encode.py ../../.tmp/readme-tech-frames
```

The output is a **1440 × 480, six-second, 20 fps** looping [GIF](../assets/readme-hero.gif) and a matching static [PNG](../assets/readme-hero.png), shared by all README languages. The renderer samples 120 deterministic frames; the encoder uses a shared palette and validates duration and looping. Frames and `contact.png` remain in `.tmp/readme-tech-frames/`.

Edit layout and time in [scene.jsx](scene.jsx), path lettering and the fixed frame in [TechText.jsx](TechText.jsx), logo paths in [Logo.jsx](Logo.jsx), and the application illustration in [HarnessCorner.jsx](HarnessCorner.jsx). The custom TechText component supports only the CoworkOS wordmark. Preview output stays in `.tmp/readme-hero/`, with no product runtime dependency. Small interface labels reuse the repository's Inter font.

The previous ElectricLogo sources and licenses remain in `react-bits/`; see [SOURCES.md](react-bits/SOURCES.md). The current scene does not import them.
