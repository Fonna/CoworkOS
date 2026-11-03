/** Isolate the upstream browser converter from every open document and draft. */
export async function importPresentationFile(file) {
  if (file.size > 32 * 1024 * 1024) throw new Error("PPTX 文件超过 32 MiB");
  const body = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const channel = crypto.randomUUID();
    const frame = document.createElement("iframe");
    frame.hidden = true;
    frame.title = "演示文稿导入器";
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    let started = false;
    const finish = (error, content) => {
      clearTimeout(timer);
      window.removeEventListener("message", receive);
      frame.remove();
      if (error) reject(error);
      else resolve({ title: file.name.replace(/\.pptx$/i, ""), content });
    };
    const receive = (event) => {
      const message = event.data;
      if (
        event.source !== frame.contentWindow ||
        event.origin !== location.origin ||
        message?.protocol !== "atria-pptist-v1" ||
        message.channel !== channel
      )
        return;
      if (message.type === "ready" && !started) {
        started = true;
        frame.contentWindow.postMessage(
          { protocol: "atria-pptist-v1", channel, type: "import-file", name: file.name, body },
          location.origin
        );
      } else if (message.type === "imported") finish(null, message.document);
      else if (message.type === "error") finish(new Error(message.message));
    };
    const timer = setTimeout(() => finish(new Error("PPTX 导入超时，请重试")), 60000);
    frame.onerror = () => finish(new Error("无法加载 PPTX 导入器"));
    window.addEventListener("message", receive);
    frame.src = `/assets/pptist/generated/index.html#channel=${channel}`;
    document.body.append(frame);
  });
}
