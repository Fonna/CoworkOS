# Windows Blender 执行

中文 | [English](en/windows-blender.md)

Windows 的内置 Blender 工作台可通过本机 WSL2 执行建模、导入、查询及 CPU 渲染。网页和数据存储仍在 Windows；不需要远程服务器。此路径不包含外部 Blender Harness 的桌面插件，也不提供 Windows 原生桌面控制、语音输入或 CadQuery 适配。

## 环境

使用已有 WSL2 Ubuntu 24.04，安装 `bubblewrap`、`libseccomp2` 以及 Blender 的系统库。以 `Ubuntu-24.04` 为例：

```powershell
wsl -d Ubuntu-24.04 -u root -- apt-get update
wsl -d Ubuntu-24.04 -u root -- apt-get install -y bubblewrap libseccomp2 libx11-6 libxi6 libxrender1 libxfixes3 libxkbcommon0 libsm6 libxxf86vm1 libgl1 libegl1 libgomp1 libfontconfig1
```

在该发行版中安装官方 Blender 4.5 LTS Linux x64 便携运行时。原生回归使用 `/opt/coworkos/blender-4.5.11-linux-x64/blender`；4.5.11 的官方 Linux 压缩包 SHA256 为 `05ed7bd41bf3e61ae4f4a7cdc364c43088bf8b3fed702c2269c018fdf63a2188`。下载后先按官方校验文件确认完整性，再解压到独立目录；不要覆盖用户的 Blender 安装。

## 启动

在启动 CoworkOS 的同一终端设置：

```powershell
$env:COWORK_BLENDER_WSL_DISTRO = 'Ubuntu-24.04'
$env:COWORK_BLENDER_WSL_EXECUTABLE = '/opt/coworkos/blender-4.5.11-linux-x64/blender'
node dist/src/cli/dashboard.js
```

修改环境变量后重启后台，已有会话和工程保留。Windows 使用此配置而不是 macOS 的 `COWORK_BLENDER_EXECUTABLE`。组件页面会探测外部 WSL 运行时；Mac 一键组件安装器不会安装或升级这个环境。

## 执行边界

每个请求建立独立临时目录。Bubblewrap 创建私有文件、进程、用户和网络命名空间，只挂载只读运行时及依赖，读写范围限于本次作业；不挂载 Windows 驱动器或用户主目录。传入的 `.blend` 字节先复制到作业目录，执行后按原有快照及 revision 规则提交。

可信 Python 桥在执行模型代码前对全部 Blender 线程安装 seccomp 规则，禁止联网、执行新程序及修改命名空间。未能建立隔离就失败，不回退为普通用户进程。环境变量通过白名单重建，模型凭据不继承。保留 2 GiB RSS 监测、文件大小、超时和取消检查；取消或 Windows 父进程断开输入管道后，Linux 代理终止并回收该作业。此实现不提供 GPU 渲染。

## 验证

先执行 `npm run build:cli`。确定性回归不自动使用 WSL 环境；显式运行实际环境验收：

```powershell
$env:COWORK_BLENDER_WSL_TEST = '1'
node scripts/test.mjs --skip-build --file test/blender-wsl.test.js
```

该文件使用上述固定测试发行版和便携运行时，工作数据位于临时目录。用例验证实际 5 cm 立方体、原生/GLB/PNG 导出、主机文件和网络拒绝、子进程拒绝、凭据隔离、超时、取消和后续恢复。未安装测试环境时须声明未验收，不能将 skip 算作通过。
