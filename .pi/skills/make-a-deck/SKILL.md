---
name: make-a-deck
description: 制作浏览器播放或打印的 HTML 幻灯片，设计叙事、导航和打印布局；指定 PPTX 时使用 presentations，绑定文稿使用 pptist。
---

# HTML 幻灯片

先加载 [frontend-design](../frontend-design/SKILL.md)，再读 [叙事与浏览器交付](references/html-deck.md)。确定受众、每页结论、证据与主要视觉；用户未指定时可采用 16:9，字号按实际画幅和展示距离选择。

使用项目已有组件或普通 HTML/CSS/JS 实现导航、页码和打印。静态内容保留为语义 HTML；需要交互图表时按需加载 charts。动效只在当前页运行，基础样式保持可见，打印和 reduced-motion 也应能读到全部内容。

验收第一页、最后一页、前后导航、键盘、输入框、窄屏、打印页数与所有资源。浏览器修改要通过实际可用的保存流程持久化，不能宣称未实现的宿主编辑能力。

Main 用 `publish_artifact` 发布 HTML 和全部依赖。用户要求 PPTX 时转 [presentations](../presentations/SKILL.md)；已绑定文稿转 [pptist](../pptist/SKILL.md)，不能把 HTML 代替指定格式或覆盖修订历史。
