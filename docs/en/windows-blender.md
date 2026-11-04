# Blender execution on Windows

English | [中文](../windows-blender.md)

The built-in Blender workbench can model, import, query and render on Windows through a local WSL2 Ubuntu environment. The UI and stored projects stay on Windows. No remote server is needed. This backend does not provide the external Blender Harness desktop plugin, Windows desktop control, speech input or CadQuery integration.

## Environment and startup

Use WSL2 Ubuntu 24.04 with bubblewrap, libseccomp2 and Blender's Linux system libraries. The [Chinese setup guide](../windows-blender.md) lists the packages. Install an official Blender 4.5 LTS Linux x64 portable runtime into a separate directory after verifying its official checksum. The native fixture uses `/opt/coworkos/blender-4.5.11-linux-x64/blender`; the 4.5.11 Linux archive SHA256 is `05ed7bd41bf3e61ae4f4a7cdc364c43088bf8b3fed702c2269c018fdf63a2188`.

Set these variables in the terminal that starts CoworkOS:

```powershell
$env:COWORK_BLENDER_WSL_DISTRO = 'Ubuntu-24.04'
$env:COWORK_BLENDER_WSL_EXECUTABLE = '/opt/coworkos/blender-4.5.11-linux-x64/blender'
node dist/src/cli/dashboard.js
```

Restart the backend after changing these variables; existing tasks and projects remain intact. This path uses the WSL executable instead of the macOS `COWORK_BLENDER_EXECUTABLE`. Component status probes the external runtime. The Mac component installer does not install or update it.

## Isolation and validation

Each request gets a temporary job directory and private bubblewrap file, process, user and network namespaces. Only runtime dependencies are mounted read-only, with writes confined to that job. Windows drives and user homes are not mounted. Input blend bytes are copied into the job and existing snapshot/revision rules govern commits.

Before model code executes, the trusted Python bridge installs kernel seccomp rules on all Blender threads to deny networking, new executables and namespace manipulation. Isolation failure rejects the request, with no unrestricted fallback. The environment is rebuilt from a whitelist without model credentials. The broker retains RSS monitoring at 2 GiB, bounded files, timeout and cancellation; closing the owned stdin pipe also drains the Linux job. GPU rendering is not provided.

Build with `npm run build:cli`, then opt in to native checks:

```powershell
$env:COWORK_BLENDER_WSL_TEST = '1'
node scripts/test.mjs --skip-build --file test/blender-wsl.test.js
```

Tests use the fixed distro/runtime above and disposable workspaces. They check real 5 cm geometry, native/GLB/PNG exports, denied host access/network/subprocesses, credential isolation, timeout, cancellation and a subsequent successful run. Ordinary deterministic runs skip this explicit native environment; skips are not acceptance evidence.
