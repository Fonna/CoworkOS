# Windows local development

[中文](../windows-development.md) | English

Use the Web frontend and local backend as the Windows development baseline. Electron source-host acceptance is separate from Windows distribution, native Computer Use, speech and CadQuery support. Blender uses [WSL2](windows-blender.md).

In PowerShell with Node >=22.19.0, run `npm ci`, `npm run build:full`, `npm run verify` and `npx playwright install chromium`. If Electron download fails, temporarily set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` for Web/CLI dependency installation. Remove it before `npm rebuild electron` for desktop acceptance. Keep any `ELECTRON_MIRROR` setting local to the terminal.

Set `ATRIA_HOME` to an isolated development directory and `COWORK_UI_PORT` to an available port, then run `npm run ui`. Use `npm run desktop` for the source desktop host. Never point tests at existing user tasks.

Run focused Node checks with `node scripts/test.mjs --skip-build --concurrency 1 --file test/process-host.test.js --file test/desktop-backend.test.js --file test/foreground-command-output.test.js --file test/test-runner.test.js` only after a matching build. Browser acceptance uses `npx playwright test e2e/workbench.spec.js e2e/human-interactions.spec.js --workers=1`; Windows desktop acceptance uses `npx playwright test e2e/windows-desktop.spec.js --workers=1`. Desktop acceptance isolates data and uses a local model fixture to verify connection, saved drafts and application relaunch. See [local testing](../testing-local-run.md) for full regression requirements.

Prefer serial regression while editors, browsers and model processes share the machine. Avoid running many Pi tests alongside a full build; under memory pressure, a short test timeout alone does not establish a lifecycle defect.

The verification runner, test build and PPTist installer invoke npm's JavaScript entry without a batch shell. Dashboard fixtures convert file URLs with `fileURLToPath` for drive letters and spaces.

If Chromium downloads are unavailable, set `COWORK_TEST_BROWSER_CHANNEL` to `chrome` or `msedge` to use an installed browser with an isolated profile. Record the selected channel; this is separate from acceptance of Playwright's bundled Chromium.

Windows managed-task stop and foreground cancellation/timeout use `taskkill /T /F` while the owned root remains alive. Desktop shutdown first requests graceful service shutdown through parent IPC, then terminates a surviving tree after timeout. Already-exited roots, host crashes and detached descendants left after normal completion do not have Job Object containment guarantees. No unrelated user processes are scanned or stopped. See [runtime boundaries](runtime-reference.md#general-and-optional-tools).

Real-model acceptance requires explicitly setting `COWORK_SMOKE_API_BASE`, `COWORK_SMOKE_API_KEY` and `COWORK_SMOKE_MODEL`, then running `node scripts/model-workflow-smoke.mjs`. It may consume model quota. The isolated workflow writes and reads a file, waits for an actual test answer, updates the artifact, restarts the service and independently checks persisted state and bytes. It outputs acceptance flags and cleans up its temporary tasks. The test answer is local; no messages are sent to other people.

WorkBuddy has its own authentication headers and chat endpoint. Protocol acceptance can use a temporary loopback relay protected by a random connection token, keeping upstream credentials in memory and suppressing upstream error bodies. This does not constitute a built-in WorkBuddy provider, installer or long-term credential-refresh integration.

If an existing local OnIt installation provides the WorkBuddy adapter, run the [development relay](../../scripts/workbuddy-relay.py) with its Python environment (including `httpx` and adapter dependencies):

```powershell
& 'your-OnIt-directory/.venv/Scripts/python.exe' scripts/workbuddy-relay.py --adapter-root 'your-OnIt-directory' --info-file .tmp/workbuddy-connection.json --model glm-5.3-flash
```

Keep that terminal running. Read the connection file from a second terminal and use its `baseUrl`, `apiKey` and `model` for an isolated development OpenAI Completions connection or the smoke above. Never commit this file. Restarting rotates the local token, so update the connection accordingly. Ctrl+C stops the relay. Production integration still needs its own authentication lifecycle and recovery behavior.

To launch Web development using terminal environment variables and an isolated home:

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

File polling uses platform-aware path boundaries. Application and Task stores retry transient Windows sharing errors during atomic replacement, retaining the complete old file until replacement succeeds. See the [tab read/write regression](../../test/application-tab-read-write.test.js) and [task state regression](../../test/task-metadata-read-write.test.js).
