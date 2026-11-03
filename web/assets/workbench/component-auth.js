/** Submit credentials once; never populate inputs from saved secrets. */
export function mountComponentAuth(host, desktop = window.bookmanDesktop) {
  const section = document.createElement("section");
  section.className = "component-auth";
  const status = document.createElement("p");
  host.append(section);
  section.append(status);
  if (!desktop?.componentAuthStatus || !desktop?.saveComponentAuth) {
    status.textContent =
      "私有组件下载：启动 CLI/Web 前设置 ATRIA_COMPONENTS_GITHUB_TOKEN（仓库 Contents: read 权限）";
    return { dispose() {} };
  }
  let disposed = false;
  const input = document.createElement("input");
  input.type = "password";
  input.autocomplete = "off";
  input.placeholder = "GitHub token";
  input.setAttribute("aria-label", "组件下载 GitHub token");
  const save = document.createElement("button"),
    clear = document.createElement("button");
  for (const button of [save, clear]) {
    button.type = "button";
    button.className = "app-button";
  }
  save.textContent = "保存下载凭据";
  clear.textContent = "清除下载凭据";
  const actions = document.createElement("div");
  actions.className = "component-actions";
  actions.append(save, clear);
  section.append(input, actions);
  const reflect = (value) => {
    if (!disposed)
      status.textContent = value.unavailable
        ? "下载凭据无法解密，请重新保存或清除"
        : value.configured
          ? "私有组件下载凭据已配置"
          : "未配置下载凭据；私有发行需要 GitHub 仓库 Contents: read 权限";
  };
  void desktop.componentAuthStatus().then(reflect, () => {
    if (!disposed) status.textContent = "下载凭据状态读取失败";
  });
  async function submit(clearToken) {
    save.disabled = clear.disabled = true;
    const token = input.value;
    input.value = "";
    try {
      reflect(await desktop.saveComponentAuth(clearToken ? { clear: true } : { token }));
    } catch {
      if (!disposed) status.textContent = "下载凭据保存失败，请检查系统密钥存储授权后重试";
    } finally {
      if (!disposed) save.disabled = clear.disabled = false;
    }
  }
  save.addEventListener("click", () => void submit(false));
  clear.addEventListener("click", () => void submit(true));
  return {
    dispose() {
      disposed = true;
      input.value = "";
    }
  };
}
