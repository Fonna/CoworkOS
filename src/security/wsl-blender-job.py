"""Trusted WSL broker. The model executes only inside a private bubblewrap namespace."""
import argparse
import json
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
import threading
import time


def command(runtime, directory):
    args = ["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--new-session",
            "--cap-drop", "ALL", "--clearenv"]
    for path in ["/usr/lib", "/lib", "/lib64", "/usr/share/fonts", "/usr/share/fontconfig", "/etc/fonts"]:
        if Path(path).exists():
            args += ["--ro-bind", path, path]
    args += ["--ro-bind", str(runtime.parent), "/runtime", "--bind", str(directory), "/job",
             "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/job"]
    for key, value in {"PATH": "/runtime", "HOME": "/job", "TMPDIR": "/job", "LANG": "C.UTF-8",
                       "BLENDER_USER_RESOURCES": "/job/user", "PYTHONDONTWRITEBYTECODE": "1",
                       "OMP_NUM_THREADS": "2", "COWORK_LINUX_SANDBOX": "1"}.items():
        args += ["--setenv", key, value]
    return args + ["/runtime/" + runtime.name, "--background", "--factory-startup", "--disable-autoexec",
                   "--offline-mode", "--threads", "2", "--python-exit-code", "1",
                   "--python", "/job/runner.py", "--", "/job/request.json"]


def rss(pid):
    """Count the namespace supervisor and its descendants, never unrelated user processes."""
    try:
        status = Path(f"/proc/{pid}/status").read_text()
        own = next((int(line.split()[1]) * 1024 for line in status.splitlines()
                    if line.startswith("VmRSS:")), 0)
        children = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
        return own + sum(rss(int(child)) for child in children)
    except (OSError, ValueError):
        return 0


def limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (128 * 1024 * 1024, 128 * 1024 * 1024))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--directory")
    parser.add_argument("--timeout", type=float, default=60)
    parser.add_argument("--probe", action="store_true")
    options = parser.parse_args()
    runtime = Path(options.runtime).resolve(strict=True)
    if not runtime.is_file() or not os.access(runtime, os.X_OK):
        raise RuntimeError("Blender executable is unavailable")
    if options.probe:
        subprocess.run(["/usr/bin/bwrap", "--unshare-all", "--die-with-parent", "--ro-bind", "/usr", "/usr",
                        "--ro-bind", "/lib", "/lib", "--ro-bind", "/lib64", "/lib64", "/usr/bin/true"],
                       check=True, timeout=10, stdout=subprocess.DEVNULL)
        version = subprocess.check_output([str(runtime), "--version"], text=True, timeout=10).splitlines()[0]
        print(json.dumps({"available": True, "backend": "wsl-bubblewrap", "executable": str(runtime),
                          "version": version.removeprefix("Blender ")}))
        return 0
    directory = Path(options.directory).resolve(strict=True)
    if not directory.is_dir() or not (directory / "request.json").is_file():
        raise RuntimeError("Missing isolated job input")
    child = subprocess.Popen(command(runtime, directory), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, start_new_session=True, preexec_fn=limits,
                             env={"PATH": "/usr/bin:/bin"})
    tail = bytearray()
    cancelled = threading.Event()

    def drain():
        while chunk := child.stdout.read(4096):
            tail.extend(chunk)
            del tail[:-16384]

    def parent():
        # Node owns this pipe. EOF covers cancellation and the Windows parent's disappearance.
        while os.read(0, 1):
            pass
        cancelled.set()

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    threading.Thread(target=parent, daemon=True).start()
    deadline = time.monotonic() + options.timeout
    failure = None
    try:
        while child.poll() is None:
            if cancelled.is_set():
                failure = "Blender task cancelled"
            elif time.monotonic() >= deadline:
                failure = "Blender task timed out"
            elif rss(child.pid) > 2 * 1024 * 1024 * 1024:
                failure = "Blender exceeded 2 GiB memory budget"
            if failure:
                break
            time.sleep(0.05)
    finally:
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        child.wait()
        reader.join(timeout=2)
    sys.stdout.buffer.write(tail)
    if failure:
        print(f"\n{failure}", file=sys.stderr)
        return 124
    return child.returncode if child.returncode >= 0 else 1


if __name__ == "__main__":
    sys.exit(main())
