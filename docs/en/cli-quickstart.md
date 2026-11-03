# CLI quickstart

[简体中文](../cli-quickstart.md) | English

macOS / Linux · Node.js >=22.19.0 · npm

## Install with npm

Requires [Node.js ≥22.19.0](https://nodejs.org/en/download) (including npm):

```sh
npm install -g coworkos-app
coworkos --version
```

Then [connect a model](#connect-a-model). To install the Mac App too, run `coworkos desktop install` on macOS 14+ Apple Silicon.

The npm package owns only the `coworkos` command. If an older global `atria-cowork-cli` installation already owns that command, uninstall that package with npm first; your `~/.atria` configuration and tasks remain. Do not use `--force` to overwrite another package's command.

The [release installer](../../scripts/install.sh) remains available for verified archive installation under `~/.local` with bash / zsh PATH setup. npm installations update with `npm install -g coworkos-app@latest`.

<details>
<summary>Manual download, verification and installation</summary>

## Open a terminal and check Node.js

On macOS, open Terminal. On Linux, open your system terminal. Run the commands below there.

```sh
node --version
npm --version
```

`node` should print `v22.19.0` or newer; `npm` should print a version number. If either command is missing or Node.js is too old, install a suitable version from [Node.js](https://nodejs.org/en/download), then reopen the terminal and check again.

## Download and install

Download both files from the [public releases](https://github.com/ignorejjj/Atria-Releases/releases) and keep them in the same directory:

- `coworkos-cli-<version>.tgz`
- `coworkos-cli-<version>.tgz.sha256`

Choose a CoworkOS release. Historical Atria archives only provide `atria`; use the installer above to expose `coworkos` for those versions. The commands below assume the files are in `~/Downloads`. Replace `<version>` with the downloaded version and adjust the directory if needed.

```sh
cd "$HOME/Downloads"
archive="coworkos-cli-<version>.tgz"
# macOS
shasum -a 256 -c "$archive.sha256"
# On Linux, use: sha256sum -c "$archive.sha256"
```

Expect the archive name followed by `OK`. After verification passes, install from the same directory. npm needs network access during installation.

```sh
npm install --global --prefix "$HOME/.local" "./$archive"
export PATH="$HOME/.local/bin:$PATH"
coworkos --version
```

The last command should print `CoworkOS` and the installed version. The `export PATH` command applies only to this terminal. If a new terminal cannot find `coworkos`, follow the [PATH troubleshooting steps](installation-reference.md#troubleshooting).

</details>

## Connect a model

Create a test folder and enter it first. The CLI reads and writes project files in the folder from which you start it; the installation directory does not need to be inside the project.

```sh
mkdir -p "$HOME/coworkos-quickstart"
cd "$HOME/coworkos-quickstart"
coworkos init
```

Enter your provider's API URL, model ID and API key in that order. The URL and model ID below are placeholders: enter your own values. Key input does not display characters.

```text
API 地址（根地址或 /v1）: https://your-service.example/v1
模型 ID: YOUR_MODEL_ID
API Key（输入隐藏）:
```

Successful setup prints `连接配置已保存：` followed by the file path, normally `~/.atria/config.json`. If it reports `配置已存在，未覆盖` (configuration exists; not overwritten), check the saved connection using [troubleshooting](installation-reference.md#troubleshooting).

New connections default to Responses. The service must support streaming and tool calls. If it only supports Chat Completions, run this in the same terminal first:

```sh
export COWORK_MODEL_API=openai-completions
```

This setting applies only to this terminal and the CLI processes it starts. To keep the format for future terminals, save it using [CLI files and environment variables](configuration.md#cli-files-and-environment-variables).

Then test the connection. This sends a model request and uses quota.

```sh
coworkos doctor --test-connection
```

Continue after all checks pass. A successful model connection prints:

```text
OK  流式模型连接与工具调用
```

If a line starts with `FAIL`, resolve the error on that line using [troubleshooting](installation-reference.md#troubleshooting), then run the same test command again.

## Complete your first task

Start from the terminal that is still in `~/coworkos-quickstart`:

```sh
coworkos
```

When the interactive interface appears, enter this request in its input area and press Enter:

> Create hello.txt in the current project, write “Hello, CoworkOS.”, then read the file and confirm its contents.

Press `Esc` to interrupt an active reply. Otherwise, wait for the task to finish and display a reply. Clear the input area, then press `Ctrl+D` to exit; this shortcut only exits when the input is empty. Back at the terminal's command prompt, run:

```sh
cat hello.txt
```

Expect:

```text
Hello, CoworkOS.
```

The file is at `~/coworkos-quickstart/hello.txt`.

## Continue using the CLI

In a new terminal, return to the same project folder and continue the latest conversation:

```sh
cd "$HOME/coworkos-quickstart"
coworkos --continue
```

Run `coworkos --resume` to choose a saved conversation. Running `coworkos` directly starts a new conversation.

[Updates & troubleshooting](installation-reference.md) · [From source](development.md#environment)
