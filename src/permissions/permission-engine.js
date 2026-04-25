import path from "node:path";

const SECRET_FILE_RE = /(^|[/\\])(\.env(\..*)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials|secrets?)([/\\]|$)/i;
const DEPENDENCY_RE = /\b(npm\s+(install|i)|pnpm\s+add|yarn\s+add|bun\s+add|pip\s+install|bundle\s+install|cargo\s+add)\b/i;
const NETWORK_RE = /\b(curl|wget|Invoke-WebRequest|iwr|fetch)\b|\bhttps?:\/\//i;
const PUSH_DEPLOY_RE = /\b(git\s+push|npm\s+publish|vercel\s+deploy|railway\s+deploy|netlify\s+deploy|supabase\s+db\s+push)\b/i;
const DESTRUCTIVE_RE = /\b(sudo|rm\s+-rf\s+(\/|~)|Remove-Item\b.*\s-Recurse|del\s+\/s|format\b|chmod\s+-R\s+777\s+\/)\b/i;
const LOCAL_CHECK_RE = new RegExp(
  [
    String.raw`\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|build)\b`,
    String.raw`\bnode\s+--test\b`,
    String.raw`\bnpx\s+(jest|vitest|mocha|playwright|cypress)\b`,
    String.raw`\bpnpm\s+exec\s+(jest|vitest|mocha|playwright|cypress)\b`,
    String.raw`\byarn\s+(jest|vitest|mocha|playwright|cypress)\b`,
    String.raw`\bbunx\s+(jest|vitest|mocha|playwright|cypress)\b`,
    String.raw`\bpython\s+-m\s+pytest\b`,
    String.raw`\bcargo\s+test\b`,
    String.raw`\bgo\s+test\b`
  ].join("|"),
  "i"
);
const READ_ONLY_RE = /^(pwd|ls|dir|Get-ChildItem|rg|grep|cat|Get-Content|git\s+status|git\s+diff|git\s+show)\b/i;

export function createPermissionEngine({ cwd, config }) {
  return {
    classifyCommand(command) {
      if (DESTRUCTIVE_RE.test(command) || /\|\s*(sh|bash|powershell|pwsh)\b/i.test(command)) {
        return decision("blocked", "destructive", "This command is destructive or runs downloaded shell code.");
      }
      if (PUSH_DEPLOY_RE.test(command)) {
        return decision("ask", "external_publish", "This would publish or push changes outside the local workspace.");
      }
      if (DEPENDENCY_RE.test(command)) {
        return decision("ask", "dependency_change", "This changes project dependencies.");
      }
      if (NETWORK_RE.test(command)) {
        return decision("ask", "network", "This uses the network.");
      }
      if (LOCAL_CHECK_RE.test(command)) {
        return config.permissions.allowLocalChecks
          ? decision("allow", "local_check", "Local project checks are allowed.")
          : decision("ask", "local_check", "Local checks require approval in this mode.");
      }
      if (READ_ONLY_RE.test(command)) {
        return decision("allow", "read_only", "Read-only workspace command.");
      }
      return decision("ask", "unknown", "This command is not recognized as a safe local command.");
    },

    classifyPath(targetPath, operation = "read") {
      const resolved = path.resolve(cwd, targetPath);
      const relative = path.relative(cwd, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return decision("ask", "outside_workspace", "This path is outside the project workspace.");
      }
      if (SECRET_FILE_RE.test(resolved)) {
        return decision("ask", "secret", "This path may contain secrets.");
      }
      if (operation === "write" && !config.permissions.allowLocalEdits) {
        return decision("ask", "local_edit", "Local edits require approval in this mode.");
      }
      return decision("allow", operation === "write" ? "local_edit" : "workspace_read", "Workspace path is allowed.");
    }
  };
}

function decision(action, tier, reason) {
  return { action, tier, reason };
}
