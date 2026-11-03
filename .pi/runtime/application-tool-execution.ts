/** Serialize a session's bound tools before they read or compute operations.
 * Other sessions and human edits remain protected by the resource store's CAS.
 */
export function createApplicationToolQueue() {
  const pending = new Map<string, Promise<unknown>>();
  return async function run<T>(resourceId: string, execute: () => Promise<T>): Promise<T> {
    const previous = pending.get(resourceId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(execute);
    pending.set(resourceId, result);
    try {
      return await result;
    } finally {
      if (pending.get(resourceId) === result) pending.delete(resourceId);
    }
  };
}

export const APPLICATION_TOOL_EXECUTION =
  "同一会话对同一资源的专用工具按调用顺序执行，读取和提交也在队列内；无需猜测并行顺序。版本由运行时处理，除非工具参数明确要求，否则无需传 revision。首次编辑先按应用要求读取当前文档；本轮完成读取后的连续修改，只有实际返回 revision_conflict 时才重新读取，结合用户修改重算；不要盲目重试覆盖用户。";
