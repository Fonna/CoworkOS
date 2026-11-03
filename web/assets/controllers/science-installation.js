const targets = ["general", "chemistry"];
const fields = { general: "pythonExecutable", chemistry: "chemistryPythonExecutable" };
const phases = {
  validating_python: "正在检查 Python",
  creating_venv: "正在创建独立环境",
  installing_dependencies: "正在下载并安装依赖",
  checking_environment: "正在验证计算环境",
  preparing: "正在准备安装",
  python: "正在检查 Python",
  checking: "正在检查 Python",
  creating: "正在创建独立环境",
  venv: "正在创建独立环境",
  installing: "正在下载并安装依赖",
  packages: "正在下载并安装依赖",
  verifying: "正在验证计算环境",
  probe: "正在验证计算环境",
  publishing: "正在完成安装"
};

/** Installation is explicit; polling never changes settings or replaces a user's draft. */
export function createScienceInstallation({ container, request, interpreter, useEnvironment }) {
  container.innerHTML = `<section class="science-environments" aria-label="安装科学环境">
    <p class="settings-note">使用下方选择的 Python 3.10+ 创建独立环境，并从 PyPI 下载固定版本依赖。安装完成后选择使用，再保存设置。现有环境和任务保留原选择。</p>
    <p class="settings-help" data-installation-error role="status"></p>
    ${targets
      .map(
        (target) => `<section class="science-environment" data-environment="${target}">
      <div><strong>${target === "general" ? "基础分析环境" : "分子计算环境"}</strong><p class="settings-help">${target === "general" ? "NumPy / SciPy · 数据分析、拟合、光谱和统计" : "RDKit · 分子结构、描述符与精确质量"}</p></div>
      <p class="settings-help" data-installation-state role="status" aria-live="polite">尚未安装</p>
      <progress data-installation-progress aria-label="${target === "general" ? "基础环境安装进度" : "分子环境安装进度"}" hidden></progress>
      <div class="science-environment-actions">
        <button type="button" class="app-button is-secondary" data-installation-start>安装${target === "general" ? "基础" : "分子"}环境</button>
        <button type="button" class="app-button is-secondary" data-installation-cancel hidden>取消${target === "general" ? "基础" : "分子"}环境安装</button>
        <button type="button" class="app-button is-secondary" data-installation-use hidden>使用${target === "general" ? "基础" : "分子"}环境</button>
      </div>
    </section>`
      )
      .join("")}
    <p class="settings-help">需要本机已有 Python 3.10+ 和网络连接。缺少解释器时请先安装 Python，或在下方填写现有解释器；安装失败可重试，关闭设置不会中断安装。</p>
  </section>`;
  const cards = Object.fromEntries(
    targets.map((target) => [target, container.querySelector(`[data-environment="${target}"]`)])
  );
  let visible = false,
    epoch = 0,
    requestId = 0,
    timer;
  let states = {};
  let actionError = "";
  let available = false;
  let managed = {};
  const pending = new Set();
  const render = () => {
    for (const target of targets) {
      const card = cards[target];
      const state = states[target] || { state: "absent" };
      const installing = state.state === "installing";
      const ready = Boolean(state.installedPython);
      const label =
        state.state === "ready"
          ? "已安装并通过检查；可填入设置供新任务使用。"
          : installing
            ? phases[state.phase] || "正在安装环境…"
            : state.state === "cancelled"
              ? "安装已取消，可重新安装。"
              : state.state === "interrupted"
                ? "上次安装未完成，可重新安装。"
                : state.state === "failed"
                  ? state.error?.message || "安装未完成，请检查 Python 和网络后重试。"
                  : "尚未安装";
      card.querySelector("[data-installation-state]").textContent =
        label + (ready && state.state !== "ready" ? " 已有环境仍可使用。" : "");
      card.querySelector("[data-installation-progress]").hidden = !installing;
      const start = card.querySelector("[data-installation-start]");
      start.hidden = installing;
      start.disabled = !available || pending.has(target);
      start.textContent = `${ready ? "重新安装" : state.state === "absent" ? "安装" : "重试安装"}${target === "general" ? "基础" : "分子"}环境`;
      const cancel = card.querySelector("[data-installation-cancel]");
      cancel.hidden = !installing;
      cancel.disabled = pending.has(target);
      const use = card.querySelector("[data-installation-use]");
      use.hidden = !ready;
      use.disabled = !available || managed[fields[target]] === true || pending.has(target);
    }
  };
  const refresh = async (current = epoch) => {
    const id = ++requestId;
    clearTimeout(timer);
    try {
      const value = await request("GET", undefined, "/environments");
      if (!visible || current !== epoch || id !== requestId) return;
      states = value;
      container.querySelector("[data-installation-error]").textContent = actionError;
      render();
      if (targets.some((target) => states[target]?.state === "installing"))
        timer = setTimeout(() => void refresh(current), 1000);
    } catch {
      if (!visible || current !== epoch || id !== requestId) return;
      container.querySelector("[data-installation-error]").textContent =
        actionError || "无法读取安装进度，当前设置已保留；重新进入此页可重试。";
      if (targets.some((target) => states[target]?.state === "installing"))
        timer = setTimeout(() => void refresh(current), 3000);
    }
  };
  const action = async (target, cancel = false) => {
    if (pending.has(target) || (!cancel && !available)) return;
    const current = epoch;
    requestId++;
    pending.add(target);
    render();
    try {
      const state = await request(
        "POST",
        {
          target,
          ...(!cancel ? { pythonExecutable: interpreter(target) } : {}),
          ...(!cancel && states[target]?.installedPython ? { reinstall: true } : {})
        },
        cancel ? "/cancel" : "/install"
      );
      if (!visible || current !== epoch) return;
      states[target] = state;
      actionError = "";
      container.querySelector("[data-installation-error]").textContent = "";
    } catch (error) {
      if (visible && current === epoch) {
        actionError = error?.message || "环境安装操作失败，请重试。";
        container.querySelector("[data-installation-error]").textContent = actionError;
      }
    } finally {
      pending.delete(target);
      if (visible) {
        render();
        void refresh(epoch);
      }
    }
  };
  for (const target of targets) {
    cards[target].querySelector("[data-installation-start]").addEventListener("click", () => {
      void action(target);
    });
    cards[target].querySelector("[data-installation-cancel]").addEventListener("click", () => {
      void action(target, true);
    });
    cards[target].querySelector("[data-installation-use]").addEventListener("click", () => {
      const python = states[target]?.installedPython;
      if (python && available && !managed[fields[target]]) useEnvironment(fields[target], python);
    });
  }
  render();
  return {
    open() {
      visible = true;
      actionError = "";
      void refresh(++epoch);
    },
    close() {
      visible = false;
      epoch++;
      clearTimeout(timer);
    },
    availability(ready, managedFields) {
      available = ready;
      managed = managedFields;
      render();
    }
  };
}
