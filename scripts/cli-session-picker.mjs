import { createInterface } from "node:readline/promises";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

function label(value) {
  return stripTerminalSequences(String(value ?? ""))
    .split("")
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("")
    .trim()
    .slice(0, 100);
}

/** Select before starting Task-scoped tools; browsing never creates a Task. */
export async function selectCliSession({
  sessions,
  input = process.stdin,
  output = process.stdout,
  readAnswer
}) {
  if (!input.isTTY || !output.isTTY)
    throw new Error(
      "会话选择需要交互终端。请使用 coworkos --continue 或 coworkos --session <ID|path>。Session selection requires a terminal; use coworkos --continue or coworkos --session <ID|path>."
    );
  const available = [...new Map(sessions.map((session) => [session.path, session])).values()];
  if (available.length === 0) {
    output.write("没有可恢复的会话；运行 coworkos 开始新任务。No saved sessions; run coworkos to start.\n");
    return null;
  }
  output.write("CoworkOS · 选择要继续的会话 / Select a session\n");
  for (const [index, session] of available.entries()) {
    const title = label(session.name || session.firstMessage || "未命名会话 / Untitled");
    output.write(`${index + 1}. ${title}\n   ${label(session.id)} · ${label(session.cwd)}\n`);
  }
  const prompt = readAnswer ? undefined : createInterface({ input, output });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  prompt?.once("close", cancel);
  prompt?.once("SIGINT", cancel);
  const ask = readAnswer ?? ((question) => prompt.question(question, { signal: controller.signal }));
  try {
    for (;;) {
      const answer = (
        await ask(
          "输入编号或完整 ID（纯数字 ID 加 id:），0 取消 / Number or ID (numeric ID: id:…), 0 to cancel: "
        )
      ).trim();
      if (answer === "0" || answer === "") return null;
      if (/^[1-9][0-9]*$/.test(answer)) {
        const selected = available[Number(answer) - 1];
        if (selected) return selected.path;
      } else {
        const id = answer.startsWith("id:") ? answer.slice(3) : answer;
        const matches = available.filter((session) => session.id === id);
        if (matches.length === 1) return matches[0].path;
        if (matches.length > 1) {
          output.write("该 ID 对应多个文件，请使用编号。This ID has multiple files; select a number.\n");
          continue;
        }
      }
      output.write("未找到该会话，请重试或输入 0 取消。Session not found; retry or enter 0.\n");
    }
  } catch (error) {
    if (error.code === "ABORT_ERR" || error.code === "ERR_USE_AFTER_CLOSE") return null;
    throw error;
  } finally {
    prompt?.removeListener("close", cancel);
    prompt?.removeListener("SIGINT", cancel);
    prompt?.close();
  }
}
