// A tool returning is distinct from the asynchronous work reaching a terminal state.
const live = new Set(["queued", "leased", "running", "waiting"]);
const success = new Set(["completed", "succeeded"]);
const failure = new Set(["failed", "timed_out"]);
const phase = (status, statusLabel) => ({ status, statusLabel });

export function outstandingWork(detail = {}) {
  const agents = new Map();
  for (const agent of [...(detail.coordination?.calls || []), ...(detail.progress?.agents || [])])
    if (agent.callId) agents.set(agent.callId, agent);
  const pending = new Set(detail.coordination?.pending || []);
  for (const agent of agents.values()) if (live.has(agent.status)) pending.add(agent.callId);
  const callbacks = new Set(detail.coordination?.callbackPending || []);
  for (const agent of agents.values()) if (agent.callbackPending) callbacks.add(agent.callId);
  return {
    agents: pending.size,
    callbacks: callbacks.size,
    jobs: (detail.jobs || []).filter((job) => job.state === "running").length,
    human: (detail.humanRequests || []).filter((request) => request.status === "pending").length
  };
}

export function toolLifecycle(name, args, data, { completed, active, detail = {} } = {}) {
  if (name === "call_subagent") {
    const callId = data.callId;
    const agent = [...(detail.progress?.agents || []), ...(detail.coordination?.calls || [])].find(
      (entry) => callId && entry.callId === callId
    );
    const callback = (detail.runtimeEvents || [])
      .map((record) => (record.type === "runtime_event" ? record.payload : record))
      .findLast(
        (event) =>
          event?.message?.customType === "cowork-callback" &&
          callId &&
          event.message.details?.callId === callId
      )?.message?.details;
    const status = agent?.status || callback?.status || data.status;
    if (failure.has(status)) return phase("failed", status === "timed_out" ? "协作超时" : "协作失败");
    if (status === "cancelled") return phase("interrupted", "协作已取消");
    if (success.has(status)) {
      if (agent?.callbackPending || detail.coordination?.callbackPending?.includes(callId))
        return phase("waiting", "结果待接收");
      return phase("completed", "协作完成");
    }
    if (live.has(status))
      return phase(
        status === "waiting" ? "waiting" : "running",
        status === "queued" ? "协作排队中" : status === "waiting" ? "协作等待中" : "协作运行中"
      );
    if (completed && (data.accepted === true || args.mode === "async")) return phase("recorded", "已派发");
  }
  if (name === "send_subagent_message" && completed) {
    if (["not_delivered", "too_late"].includes(data.delivered)) return phase("interrupted", "未送达");
    return phase("completed", data.delivered === "unblocked_waiting_subagent" ? "已解答" : "已入队");
  }
  if (name === "askhuman") {
    const request = (detail.humanRequests || []).find((entry) =>
      data.requestId ? entry.requestId === data.requestId : !completed && entry.question === args.question
    );
    const status = request?.status || data.status;
    if (status === "pending") return phase("waiting", "等待答复");
    if (!completed) return active === false ? undefined : phase("waiting", "等待答复");
    if (status === "answered") return phase("completed", "已答复");
    if (["timeout", "unanswered"].includes(status)) return phase("recorded", "未答复，已继续");
    if (status === "cancelled") return phase("interrupted", "询问已取消");
    return phase("recorded", "询问已结束");
  }
  if (name === "start_job" && completed && data.jobId) {
    const job = (detail.jobs || []).find(
      (entry) => entry.jobId === data.jobId && (!data.logPath || entry.logPath === data.logPath)
    );
    if (!job) return phase("recorded", "已启动后台任务");
    if (job.state === "running") return phase("running", "后台运行中");
    if (job.signal) return phase("interrupted", "后台任务已停止");
    if (job.exitCode === 0) return phase("completed", "后台任务完成");
    if (typeof job.exitCode === "number") return phase("failed", "后台任务失败");
    return phase("interrupted", "已退出，结果待核实");
  }
  if (name === "wait_for_subagents" && completed) {
    const watched = new Set([...(data.pending || []), ...(data.callbackPending || [])]);
    const coordination = detail.coordination;
    if (coordination && watched.size) {
      const calls = [...(detail.progress?.agents || []), ...(coordination.calls || [])];
      if (
        coordination.pending?.some((id) => watched.has(id)) ||
        calls.some((entry) => watched.has(entry.callId) && live.has(entry.status))
      )
        return phase("waiting", "协作仍在运行");
      if (
        coordination.callbackPending?.some((id) => watched.has(id)) ||
        calls.some((entry) => watched.has(entry.callId) && entry.callbackPending)
      )
        return phase("waiting", "结果待接收");
      return phase("completed", "等待已结束");
    }
    if (data.pending?.length) return phase("waiting", "协作仍在运行");
    if (data.callbackPending?.length) return phase("waiting", "结果待接收");
    return phase("completed", "等待已结束");
  }
  if (name === "sleep_until" && completed && data.parked) return phase("waiting", "等待唤醒");
}
