export function parseUnifiedPatch(patchText) {
  const lines = patchText.replace(/\r\n/g, "\n").split("\n");
  const files = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith("--- ")) {
      index += 1;
      continue;
    }

    const oldPath = cleanPatchPath(lines[index].slice(4).trim());
    index += 1;
    if (!lines[index]?.startsWith("+++ ")) {
      throw new Error("Invalid patch: expected +++ path after --- path.");
    }
    const newPath = cleanPatchPath(lines[index].slice(4).trim());
    index += 1;

    const filePatch = {
      oldPath,
      newPath,
      path: newPath === "/dev/null" ? oldPath : newPath,
      hunks: []
    };

    while (index < lines.length && !lines[index].startsWith("--- ")) {
      if (!lines[index].startsWith("@@")) {
        index += 1;
        continue;
      }
      const header = lines[index];
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
      if (!match) throw new Error(`Invalid patch hunk header: ${header}`);
      index += 1;

      const hunk = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] || "1"),
        newStart: Number(match[3]),
        newCount: Number(match[4] || "1"),
        lines: []
      };

      while (
        index < lines.length
        && !lines[index].startsWith("@@")
        && !lines[index].startsWith("--- ")
      ) {
        const line = lines[index];
        if (line === "" && index === lines.length - 1) {
          index += 1;
          break;
        }
        if (line === "\\ No newline at end of file") {
          index += 1;
          continue;
        }
        const marker = line[0];
        if (![" ", "+", "-"].includes(marker)) {
          throw new Error(`Invalid patch line: ${line}`);
        }
        hunk.lines.push({ type: marker, text: line.slice(1) });
        index += 1;
      }

      filePatch.hunks.push(hunk);
    }

    files.push(filePatch);
  }

  if (files.length === 0) throw new Error("Invalid patch: no file patches found.");
  return files;
}

export function applyFilePatch(originalContent, filePatch) {
  if (filePatch.newPath === "/dev/null") {
    throw new Error("Deleting files through apply_patch is not implemented yet.");
  }

  const hadTrailingNewline = originalContent.endsWith("\n");
  const original = splitLines(originalContent);
  const output = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (hunkStart < cursor) {
      throw new Error(`Overlapping hunk for ${filePatch.path}.`);
    }

    output.push(...original.slice(cursor, hunkStart));
    cursor = hunkStart;

    for (const line of hunk.lines) {
      if (line.type === " ") {
        assertOriginalLine(original, cursor, line.text, filePatch.path);
        output.push(original[cursor]);
        cursor += 1;
      } else if (line.type === "-") {
        assertOriginalLine(original, cursor, line.text, filePatch.path);
        cursor += 1;
      } else if (line.type === "+") {
        output.push(line.text);
      }
    }
  }

  output.push(...original.slice(cursor));
  const result = output.join("\n");
  return hadTrailingNewline || output.length > 0 ? `${result}\n` : result;
}

function splitLines(content) {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n");
}

function assertOriginalLine(original, index, expected, filePath) {
  const actual = original[index];
  if (actual !== expected) {
    throw new Error([
      `Patch context did not match in ${filePath} at line ${index + 1}.`,
      `Expected: ${expected}`,
      `Actual: ${actual ?? "<end of file>"}`
    ].join(" "));
  }
}

function cleanPatchPath(rawPath) {
  const pathWithoutTimestamp = rawPath.split(/\t|  /)[0];
  if (pathWithoutTimestamp === "/dev/null") return pathWithoutTimestamp;
  return pathWithoutTimestamp.replace(/^[ab]\//, "");
}
