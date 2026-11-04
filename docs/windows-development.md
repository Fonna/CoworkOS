# Windows 本机开发

中文 | [English](en/windows-development.md)

Windows 的开发主线是 Web 与本地后台服务。Electron 源码宿主提供独立验收；这不代表 Windows 安装包、原生 Computer Use、语音输入或 CadQuery 已交付。Blender 走 [WSL2](windows-blender.md)。

## 准备与启动

使用 Node >=22.19.0 和 PowerShell：

```powershell
npm ci
npm run build:full
npm run verify
npx playwright install chromium
```

Electron 下载失败时，可暂时设置 `$env:ELECTRON_SKIP_BINARY_DOWNLOAD='1'` 后安装 Web/CLI 依赖；桌面验收前移除该变量并执行 `npm rebuild electron`。下载网络需要镜像时，仅在当前终端设置 `ELECTRON_MIRROR`，不要把本机网络配置写进源码。

开发数据使用独立目录，不指向已有用户任务：

```powershell
$env:ATRIA_HOME = Join-Path $env:TEMP 'cowork-development'
$env:COWORK_UI_PORT = '3881'
npm run ui
# 单独启动桌面宿主：npm run desktop
```

## 验收入口

```powershell
node scripts/test.mjs --skip-build --concurrency 1 --file test/process-host.test.js --file test/desktop-backend.test.js --file test/foreground-command-output.test.js --file test/test-runner.test.js
npx playwright test e2e/workbench.spec.js e2e/human-interactions.spec.js --workers=1
npx playwright test e2e/windows-desktop.spec.js --workers=1
```

`--skip-build` 仅用于已有与源码一致的构建。桌面用例使用隔离数据和本地模型，检查连接、草稿保存和应用重开；浏览器、原生驱动、真实账号及安装包是独立证据。完整回归见 [本地测试指南](testing-local-run.md)。

本机同时运行编辑器、浏览器和模型进程时，优先串行执行回归；不要与完整构建同时跑大量 Pi 测试。资源紧张时，短测试超时不能作为生命周期问题的唯一证据。

Chromium 下载受限时，可用已安装的 Chrome 或 Edge：先设置 `$env:COWORK_TEST_BROWSER_CHANNEL='chrome'` 或 `'msedge'`，再执行上述浏览器命令。测试仍使用独立浏览器配置，不读取个人浏览记录；这项结果须记录为对应浏览器渠道，不能记为 Playwright 自带 Chromium 验收。

Windows 验证、测试构建和 PPTist 依赖安装通过 npm 的 JavaScript 入口执行，避免 `.cmd` 无 shell 启动错误。测试工作区通过 `fileURLToPath` 转换文件 URL，支持 Windows 盘符和空格。

受管任务停止及前台命令取消/超时在根进程存活时通过 `taskkill /T /F` 清理进程树。桌面先通过可信父子 IPC 请求服务正常关闭，超时才强制终止。根进程已经退出、宿主崩溃、正常结束后遗留的脱离后代，不具有 Job Object 级的完整回收保证；不会扫描或终止其他用户进程。详见 [运行边界](runtime-reference.md#通用与可选工具)。

## 真实模型闭环

开发专用 smoke 必须显式配置，可能消耗模型额度：

```powershell
$env:COWORK_SMOKE_API_BASE = 'http://127.0.0.1:端口'
$env:COWORK_SMOKE_API_KEY = '本机测试连接令牌'
$env:COWORK_SMOKE_MODEL = '模型名称'
node scripts/model-workflow-smoke.mjs
```

入口创建隔离工作区，要求实际模型写入并读回文件、提出问题、等待测试答案、修改成果，随后重启服务并独立核验状态与文件。只输出验收标志；临时任务随测试关闭清理。测试答案由 smoke 提交，不会向其他人发送消息。

WorkBuddy 使用自己的认证头与聊天入口，不能直接把普通 OpenAI 地址配置当作已完成接入。可经仅监听本机、具有随机连接令牌的临时中继做协议验收；中继在内存中使用认证，不能向客户端返回上游凭据或错误正文。此验证不等于已交付内置 WorkBuddy provider、安装器或长期授权刷新集成。

已有本机 OnIt 的 WorkBuddy 适配器时，可用其 Python 环境启动[开发中继](../scripts/workbuddy-relay.py)（需要该环境已安装 `httpx` 等适配器依赖）：

```powershell
& '你的OnIt目录/.venv/Scripts/python.exe' scripts/workbuddy-relay.py --adapter-root '你的OnIt目录' --info-file .tmp/workbuddy-connection.json --model glm-5.3-flash
```

保持此终端运行。在另一个终端读取连接文件，将其中的 `baseUrl`、`apiKey` 和 `model` 填入独立开发配置的 OpenAI Completions 连接，或用于上面的 smoke。不要把连接文件提交到 Git；每次中继重启都会更换本机令牌，旧连接需同步更新。Ctrl+C 停止中继；生产接入仍需独立实现认证生命周期与错误恢复。

也可直接使用当前终端的环境变量启动 Web 开发环境，无需写入现有用户配置：

```powershell
$connection = Get-Content .tmp/workbuddy-connection.json -Raw | ConvertFrom-Json
$env:ATRIA_HOME = Join-Path $PWD '.tmp/local-development-home'
New-Item -ItemType Directory -Force $env:ATRIA_HOME | Out-Null
$env:COWORK_CONFIG = Join-Path $env:ATRIA_HOME 'config.json'
if (!(Test-Path -LiteralPath $env:COWORK_CONFIG)) { '{}' | Set-Content -Encoding ascii $env:COWORK_CONFIG }
$env:COWORK_WORKSPACE = Join-Path $env:ATRIA_HOME 'workspace'
$env:PI_CODING_AGENT_DIR = Join-Path $env:ATRIA_HOME 'pi'
$env:COWORK_MODEL_API = 'openai-completions'
$env:COWORK_API_BASE = $connection.baseUrl
$env:COWORK_API_KEY = $connection.apiKey
$env:COWORK_MODEL = $connection.model
$env:COWORK_REASONING_EFFORT = 'off'
$env:COWORK_SUPPORTS_REASONING_EFFORT = '0'
npm run ui
```

文件监听使用平台路径边界；应用及 Task 存储的原子替换对 Windows 临时文件占用做有限重试，保留完整旧文件直到新文件替换成功。并发读写回归见 [标签测试](../test/application-tab-read-write.test.js)与[任务状态测试](../test/task-metadata-read-write.test.js)。
