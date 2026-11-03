import { defaultComputeBudget, computeBudget } from "./generated/program.js";
/** Cancel obsolete geometry rather than accumulating unbounded CPU jobs. */
export class CadKernelClient {
  pending = null;
  counter = 0;
  disposed = false;
  constructor({ preview } = {}) {
    this.preview = preview;
  }
  request(type, model, selected, { timeoutMs = defaultComputeBudget(model) } = {}) {
    if (this.disposed) return Promise.reject(new Error("CAD 窗口已关闭"));
    try {
      computeBudget(timeoutMs);
    } catch (error) {
      return Promise.reject(error);
    }
    this.cancel();
    const id = ++this.counter;
    if (model.engine === "cadquery") {
      if (type !== "mesh" || !this.preview)
        return Promise.reject(new Error("CadQuery 通过本地精确内核预览；导出请使用文件菜单"));
      const controller = new AbortController();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, result) => {
          if (settled) return;
          settled = true;
          if (this.pending?.id === id) this.pending = null;
          if (error) reject(error);
          else resolve(result);
        };
        this.pending = {
          id,
          cancel: () => {
            controller.abort();
            finish(null, null);
          }
        };
        this.preview(model, { timeoutMs }, controller.signal)
          .then((result) => {
            if (settled) return;
            if (!Array.isArray(result?.positions) || !Array.isArray(result?.features))
              throw new Error("CAD 预览响应不完整，请重试；源码已保留");
            result.positions = new Float32Array(result.positions);
            for (const feature of result.features) feature.positions = new Float32Array(feature.positions);
            finish(null, result);
          })
          .catch((error) => finish(error));
      });
    }
    const worker = new Worker(new URL("./generated/worker.js", import.meta.url), { type: "module" });
    return new Promise((resolve, reject) => {
      const finish = (error, result) => {
        clearTimeout(timer);
        worker.terminate();
        if (this.pending?.id === id) this.pending = null;
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(
        () => finish(new Error("几何预览超时；源码已保留，可增加计算预算重试")),
        timeoutMs
      );
      this.pending = { id, cancel: () => finish(null, null) };
      worker.onerror = () => finish(new Error("CAD 几何内核加载失败"));
      worker.onmessage = ({ data }) => {
        if (data.id === id) finish(data.error ? new Error(data.error) : null, data);
      };
      worker.postMessage({ id, type, model, selected, timeoutMs });
    });
  }
  cancel() {
    this.pending?.cancel();
  }
  dispose() {
    this.disposed = true;
    this.cancel();
  }
}
