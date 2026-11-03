const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const filename = (value) =>
  String(value || "")
    .replaceAll("\\", "/")
    .split("/")
    .pop() || "";

// Describe literal arguments only. Never evaluate shell syntax or guess which
// command in a compound/substituted expression will run successfully.
function commandTokens(command) {
  const tokens = [];
  let token = "",
    quote = "",
    escaped = false,
    started = false,
    literal = true,
    substitution = "",
    substitutionQuote = "",
    depth = 0;
  const source = String(command || "").trim();
  const flush = () => {
    if (started) tokens.push({ value: token, literal });
    token = "";
    started = false;
    literal = true;
  };
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (substitution) {
      token += character;
      if (character === "\\" && substitutionQuote !== "'") {
        escaped = true;
        continue;
      }
      if (substitutionQuote) {
        if (character === substitutionQuote) substitutionQuote = "";
      } else if (substitution !== "`" && /['"`]/.test(character)) substitutionQuote = character;
      else if (character === substitution) {
        if (--depth === 0) substitution = "";
      } else if ((substitution === ")" && character === "(") || (substitution === "}" && character === "{"))
        depth++;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = "";
      else {
        if (quote === '"' && (character === "$" || character === "`")) literal = false;
        token += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (character === "$" || character === "`") {
      literal = false;
      started = true;
      token += character;
      if (character === "`") {
        substitution = "`";
        depth = 1;
      } else if (source[index + 1] === "(" || source[index + 1] === "{") {
        const opening = source[++index];
        token += opening;
        substitution = opening === "(" ? ")" : "}";
        depth = 1;
      }
      continue;
    }
    if (/[|;&<>\n\r()]/.test(character)) {
      flush();
      let operator = character;
      if (source[index + 1] === character && /[|&<>]/.test(character)) operator += source[++index];
      tokens.push({ operator });
      continue;
    }
    if (/\s/.test(character)) {
      flush();
    } else {
      token += character;
      started = true;
    }
  }
  const complete = !escaped && !quote && !substitution;
  if (complete) flush();
  return { tokens, complete };
}

function executableWords(words) {
  let index = 0;
  let envIndex = -1;
  while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index++;
  if (words[index]?.literal && filename(words[index].value) === "env") {
    envIndex = index;
    index++;
    while (words[index]?.literal && words[index].value.startsWith("-")) {
      if (["-i", "--ignore-environment", "--"].includes(words[index].value)) index++;
      else if (["-u", "--unset"].includes(words[index].value)) index += 2;
      else if (words[index].value.startsWith("--unset=")) index++;
      else return words.slice(envIndex);
    }
  }
  while (words[index] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index++;
  if (!words[index] && envIndex >= 0) return words.slice(envIndex);
  return words.slice(index);
}

function searchDescription(executable, arguments_) {
  const queries = [],
    paths = [],
    filters = [];
  let filesOnly = false,
    options = true;
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index];
    if (options && argument === "--") {
      options = false;
      continue;
    }
    if (options && argument === "--files" && executable === "rg") {
      filesOnly = true;
      continue;
    }
    if (options && (argument === "-e" || argument === "--regexp")) {
      if (!arguments_[index + 1]) return undefined;
      queries.push(arguments_[++index]);
      continue;
    }
    if (options && argument.startsWith("--regexp=")) {
      queries.push(argument.slice("--regexp=".length));
      continue;
    }
    if (options && ["-g", "--glob", "--iglob"].includes(argument)) {
      if (!arguments_[index + 1]) return undefined;
      filters.push(arguments_[++index]);
      continue;
    }
    if (
      options &&
      [
        "-m",
        "--max-count",
        "--max-depth",
        "-A",
        "-B",
        "-C",
        "--context",
        "-t",
        "-T",
        "--type",
        "--type-not"
      ].includes(argument)
    ) {
      if (!arguments_[++index]) return undefined;
      continue;
    }
    if (options && argument.startsWith("-")) {
      if (
        /^-[niIlLHQqvVrRwWxFxUuSsaocbhz]+$/.test(argument) ||
        /^-(?:m|A|B|C)\d+$/.test(argument) ||
        [
          "--hidden",
          "--no-ignore",
          "--line-number",
          "--ignore-case",
          "--smart-case",
          "--fixed-strings",
          "--multiline",
          "--files-with-matches",
          "--files-without-match",
          "--count",
          "--only-matching",
          "--recursive",
          "--no-messages"
        ].includes(argument) ||
        /^--(?:glob|iglob|type|type-not|max-count|max-depth|context)=/.test(argument)
      )
        continue;
      return undefined;
    }
    if (!filesOnly && !queries.length) queries.push(argument);
    else paths.push(argument);
  }
  if (filesOnly)
    return {
      title: "查找文件",
      subject: paths[0] || "当前目录",
      summary: filters.length ? `文件名：${filters[0]}` : ""
    };
  if (!queries.length) return undefined;
  return {
    title: "搜索文件内容",
    subject: queries[0],
    summary: paths.length ? `范围：${paths[0]}` : ""
  };
}

function describeLiteralCommand(tokens) {
  const executable = filename(tokens[0]);
  const generic = { title: "运行命令", subject: executable || "终端命令" };
  const arguments_ = tokens.slice(1);
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    for (let index = 0; index < arguments_.length; index++) {
      const argument = arguments_[index];
      if (["-V", "--version", "-h", "--help"].includes(argument))
        return { title: "查看 Python 信息", subject: "Python" };
      if (argument === "-m") return { title: "运行 Python 模块", subject: arguments_[index + 1] || "Python" };
      if (argument === "-c" || argument === "-") return { title: "运行 Python 代码", subject: "内联代码" };
      if (argument === "-W" || argument === "-X" || argument === "--check-hash-based-pycs") {
        index++;
        continue;
      }
      if (argument.startsWith("-")) continue;
      return /\.py$/i.test(argument)
        ? { title: "运行 Python 脚本", subject: filename(argument) }
        : { title: "运行 Python", subject: filename(argument) || "Python" };
    }
    return { title: "运行 Python", subject: "Python" };
  }
  if (/^(?:node|nodejs)$/.test(executable)) {
    for (let index = 0; index < arguments_.length; index++) {
      const argument = arguments_[index];
      if (["-e", "--eval", "-p", "--print"].includes(argument) || /^--(?:eval|print)=/.test(argument))
        return { title: "运行 JavaScript 代码", subject: "内联代码" };
      if (["-v", "--version", "-h", "--help"].includes(argument))
        return { title: "查看 Node.js 信息", subject: "Node.js" };
      if (["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(argument)) {
        index++;
        continue;
      }
      if (argument === "--") {
        const script = arguments_[index + 1];
        return script ? { title: "运行 Node.js 脚本", subject: filename(script) } : generic;
      }
      if (argument.startsWith("-")) continue;
      return { title: "运行 Node.js 脚本", subject: filename(argument) };
    }
  }
  if (["npm", "pnpm", "yarn", "bun"].includes(executable)) {
    const task = arguments_[0] === "run" ? arguments_[1] : arguments_[0];
    if (
      task &&
      !task.startsWith("-") &&
      (arguments_[0] === "run" || ["test", "start", "stop", "restart"].includes(task))
    )
      return {
        title: /^(?:test|check)(?::|$)/.test(task) ? "运行测试" : "运行项目脚本",
        subject: `${executable} ${arguments_[0] === "run" ? "run " : ""}${task}`
      };
  }
  if (/^pytest(?:\d+)?$/.test(executable))
    return {
      title: "运行 Python 测试",
      subject: arguments_.find((argument) => !argument.startsWith("-")) || executable
    };
  if (["rg", "grep"].includes(executable)) return searchDescription(executable, arguments_) || generic;
  if (executable === "find") {
    if (arguments_.some((argument) => /^-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)/.test(argument)))
      return generic;
    const directory = arguments_.find((argument) => !["-H", "-L", "-P"].includes(argument));
    const patternIndex = arguments_.findIndex((argument) =>
      ["-name", "-iname", "-path", "-ipath"].includes(argument)
    );
    return {
      title: "查找文件",
      subject: directory && !directory.startsWith("-") ? directory : "当前目录",
      summary:
        patternIndex >= 0 && arguments_[patternIndex + 1] ? `匹配：${arguments_[patternIndex + 1]}` : ""
    };
  }
  if (executable === "ls" || executable === "mkdir") {
    const paths = [];
    let options = true;
    for (let index = 0; index < arguments_.length; index++) {
      const argument = arguments_[index];
      if (options && argument === "--") options = false;
      else if (options && argument.startsWith("-")) {
        const values =
          executable === "mkdir" ? ["-m", "--mode"] : ["-I", "--ignore", "-w", "--width", "-T", "--tabsize"];
        if (values.includes(argument)) index++;
        else if (executable === "mkdir" && !/^-[pv]+$|^--(?:parents|verbose)$|^--mode=/.test(argument))
          return generic;
        else if (
          executable === "ls" &&
          !/^-[aAbBcCdDeEfFgGhHiIkKlLmMnNoOpPqQrRsStTuUvVwWxXyYzZ1@]+$|^--(?:all|almost-all|directory|classify|human-readable|numeric-uid-gid|reverse|recursive|full-time|file-type|group-directories-first)$|^--(?:color|sort|time|format|quoting-style|block-size|ignore|width|tabsize)=/.test(
            argument
          )
        )
          return generic;
      } else paths.push(argument);
    }
    if (executable === "mkdir" && !paths.length) return generic;
    return {
      title: executable === "mkdir" ? "创建目录" : "查看文件列表",
      subject: paths[0] || "当前目录",
      summary: paths.length > 1 ? `共 ${paths.length} 个${executable === "mkdir" ? "目录" : "路径"}` : ""
    };
  }
  if (executable === "officecli") {
    const action = arguments_[0];
    if (["help", "--help", "-h"].includes(action))
      return { title: "查看文档操作帮助", subject: arguments_[1] || "officecli" };
    if (["validate", "view"].includes(action)) {
      const operands = [];
      for (let index = 1; index < arguments_.length; index++) {
        const argument = arguments_[index];
        if (["--output", "--outdir", "--format"].includes(argument)) index++;
        else if (["--file", "--input"].includes(argument)) operands.push(arguments_[++index]);
        else if (!argument.startsWith("-")) operands.push(argument);
        else if (!["--json", "--quiet", "--verbose", "--strict"].includes(argument)) return generic;
      }
      const input = operands.find((argument) => typeof argument === "string" && /\.pptx$/i.test(argument));
      if (input)
        return { title: action === "validate" ? "检查演示文稿" : "查看演示文稿", subject: filename(input) };
    }
  }
  if (["soffice", "libreoffice"].includes(executable)) {
    let format = "";
    const inputs = [];
    for (let index = 0; index < arguments_.length; index++) {
      const argument = arguments_[index];
      if (argument === "--convert-to") format = arguments_[++index] || "";
      else if (["--outdir", "--infilter"].includes(argument)) index++;
      else if (argument.startsWith("-")) {
        if (
          !/^--(?:headless|invisible|nologo|nodefault|norestore|nofirststartwizard|nolockcheck)$/.test(
            argument
          )
        )
          return generic;
      } else inputs.push(argument);
    }
    if (/^pdf(?::|$)/i.test(format) && inputs.length)
      return {
        title: "导出 PDF",
        subject: filename(inputs[0]),
        summary: inputs.length > 1 ? `共 ${inputs.length} 个输入文件` : ""
      };
  }
  return generic;
}

function pythonHeredoc(command) {
  const match = String(command || "")
    .trim()
    .match(/^([^\n]+?)\s*<<(-?)\s*(?:(['"])([A-Za-z_]\w*)\3|([A-Za-z_]\w*))\s*\r?\n([\s\S]*)$/);
  if (!match) return undefined;
  const head = commandTokens(match[1]);
  const words = executableWords(head.tokens);
  if (!head.complete || head.tokens.some((word) => word.operator || !word.literal)) return undefined;
  if (!/^python(?:\d+(?:\.\d+)*)?$/.test(filename(words[0]?.value)) || words.at(-1)?.value !== "-")
    return undefined;
  if (words.some((word) => ["-c", "-m", "-V", "--version", "-h", "--help"].includes(word.value)))
    return undefined;
  const delimiter = match[4] || match[5];
  const lines = match[6].split(/\r?\n/);
  const closing = lines.findIndex((line) => (match[2] ? line.replace(/^\t+/, "") : line) === delimiter);
  if (closing !== lines.length - 1) return undefined;
  return { title: "运行 Python 脚本", subject: "内嵌脚本" };
}

export function describeCommand(value) {
  const args = record(value) ? value : { command: value };
  if (!args.args?.length) {
    const heredoc = pythonHeredoc(args.command);
    if (heredoc) return heredoc;
  }
  if (typeof args.command !== "string") return { title: "运行命令", subject: "终端" };
  const parsed = commandTokens(args.command);
  if (Array.isArray(args.args) && args.args.every((argument) => typeof argument === "string"))
    parsed.tokens.push(
      ...args.args.map((argument) =>
        /^(?:&&|\|\||[|;&<>])$/.test(argument) ? { operator: argument } : { value: argument, literal: true }
      )
    );
  const operatorIndex = parsed.tokens.findIndex((token) => token.operator);
  const firstWords = executableWords(
    operatorIndex < 0 ? parsed.tokens : parsed.tokens.slice(0, operatorIndex)
  );
  const executable = firstWords[0]?.literal ? filename(firstWords[0].value) : "";
  if (!executable) return { title: "运行命令", subject: "终端" };
  const literal = parsed.complete && parsed.tokens.every((token) => !token.operator && token.literal);
  if (literal) return describeLiteralCommand(firstWords.map((word) => word.value));
  const operators = parsed.tokens.filter((token) => token.operator);
  if (parsed.complete && operators.length === 1 && operators[0].operator === "|") {
    const nextWords = executableWords(parsed.tokens.slice(operatorIndex + 1));
    if (
      parsed.tokens.filter((word) => !word.operator).every((word) => word.literal) &&
      nextWords.length &&
      nextWords.every((word) => word.literal)
    ) {
      const first = describeLiteralCommand(firstWords.map((word) => word.value));
      return {
        ...first,
        summary: `${first.summary ? `${first.summary}；` : ""}首步操作，后续交给 ${filename(nextWords[0].value)}`
      };
    }
  }
  // A chain's exit status belongs to the whole group, not its first executable.
  // Heredoc bodies are not tokenized as shell commands here.
  const chained =
    !operators.some((token) => token.operator === "<<") &&
    operators.some((token) => /^(?:;|&&|\|\||\||[\n\r])$/.test(token.operator));
  return { title: "执行组合命令", subject: chained ? `${executable} 等命令` : executable };
}
