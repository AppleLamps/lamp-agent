const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m"
};

export function createTerminalUi({ output, input = process.stdin, env = process.env }) {
  const color = Boolean(output.isTTY) && env.NO_COLOR !== "1";

  return {
    banner(version) {
      return [
        paint(color, ANSI.bold + ANSI.cyan, `Lamp Agent ${version}`),
        paint(color, ANSI.gray, "Plain-English coding harness"),
        "",
        paint(color, ANSI.dim, "Ask for code work in normal language. Use /help for commands."),
        ""
      ].join("\n");
    },

    prompt() {
      return paint(color, ANSI.bold + ANSI.green, "agent") + paint(color, ANSI.gray, " > ");
    },

    user(text) {
      return `${paint(color, ANSI.bold + ANSI.green, "you")} ${text}`;
    },

    assistant(text) {
      return box("assistant", text, { color, borderColor: ANSI.cyan });
    },

    /**
     * Header printed before streamed assistant tokens. Cheaper than
     * re-boxing on every token: a clear "assistant >" marker plus a
     * dim rule-line, then raw tokens flow directly to stdout, then
     * `assistantStreamFooter` closes the block.
     */
    assistantStreamHeader(label = "assistant") {
      const tag = paint(color, ANSI.bold + ANSI.cyan, `${label} >`);
      return `${tag}`;
    },

    assistantStreamFooter() {
      return paint(color, ANSI.gray, "---");
    },

    card(title, text) {
      return box(title, text, { color, borderColor: ANSI.gray });
    },

    progress(text) {
      return `${paint(color, ANSI.cyan, ">")} ${paint(color, ANSI.dim, text)}`;
    },

    success(text) {
      return `${paint(color, ANSI.green, "ok")} ${text}`;
    },

    warning(text) {
      return `${paint(color, ANSI.yellow, "warn")} ${text}`;
    },

    error(text) {
      return `${paint(color, ANSI.red, "error")} ${text}`;
    },

    approval(message) {
      return [
        box("approval needed", message, { color, borderColor: ANSI.yellow }),
        "Choose: yes | no | explain"
      ].join("\n");
    },

    color
  };
}

export function box(title, text, options = {}) {
  const color = Boolean(options.color);
  const borderColor = options.borderColor || ANSI.gray;
  const width = Math.min(Math.max(58, title.length + 4, maxLineLength(text) + 4), 96);
  const top = `+-- ${title} ${"-".repeat(Math.max(0, width - title.length - 6))}+`;
  const bottom = `+${"-".repeat(width - 2)}+`;
  const body = wrapText(text, width - 4)
    .flatMap((line) => line === "" ? [""] : [line])
    .map((line) => `| ${line.padEnd(width - 4, " ")} |`);
  const lines = [top, ...body, bottom];
  return lines.map((line) => paint(color, borderColor, line)).join("\n");
}

export function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function paint(enabled, code, text) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

function maxLineLength(text) {
  return String(text).split(/\r?\n/).reduce((max, line) => Math.max(max, stripAnsi(line).length), 0);
}

function wrapText(text, width) {
  const result = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    if (rawLine.length <= width) {
      result.push(rawLine);
      continue;
    }
    let line = rawLine;
    while (line.length > width) {
      let index = line.lastIndexOf(" ", width);
      if (index <= 0) index = width;
      result.push(line.slice(0, index));
      line = line.slice(index).trimStart();
    }
    result.push(line);
  }
  return result;
}
