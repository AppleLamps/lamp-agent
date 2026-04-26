import { select } from "@inquirer/prompts";

export function createInteractivePrompts({ input = process.stdin, output = process.stdout } = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY);

  return {
    interactive,

    async approval({ message, askEveryTime = false }) {
      if (!interactive) return { handled: false };
      const choice = await select({
        message,
        choices: [
          {
            name: askEveryTime ? "Allow once" : "Allow for this task",
            value: "allow",
            description: "Run this operation and continue."
          },
          {
            name: "Deny",
            value: "deny",
            description: "Skip this operation."
          },
          {
            name: "Explain",
            value: "explain",
            description: "Show why the harness is asking."
          },
          {
            name: "Choose another approach",
            value: "alternative",
            description: "Deny this operation and ask the agent to continue without it."
          },
          {
            name: "Cancel task",
            value: "cancel",
            description: "Stop this task without approving the operation."
          }
        ]
      });
      return { handled: true, choice };
    },

    async reviewAction() {
      if (!interactive) return { handled: false };
      const choice = await select({
        message: "Next action",
        choices: [
          { name: "Accept", value: "accept", description: "Keep the local result." },
          { name: "Adjust", value: "adjust", description: "Enter a follow-up request at the prompt." },
          { name: "See diff", value: "diff", description: "Show the active task diff summary." },
          { name: "Preview pending changes", value: "preview", description: "Show a unified-diff preview of what accepting would commit." },
          { name: "See technical details", value: "details", description: "Show task artifacts, checks, phases, and command log status." },
          { name: "Open changed file list", value: "changed_files", description: "Show files tracked as changed for this task." },
          { name: "Resolve apply-back conflict", value: "resolve_conflicts", description: "Resolve pending shadow apply-back conflicts." },
          { name: "Undo", value: "undo", description: "Restore tracked files from snapshots." },
          { name: "Cancel task", value: "cancel_task", description: "Mark the active task canceled." },
          { name: "Continue chatting", value: "continue", description: "Return to the prompt." }
        ]
      });
      return { handled: true, choice };
    },

    async conflictResolution(conflict) {
      if (!interactive) return { handled: false };
      const choice = await select({
        message: `Resolve ${conflict.path}`,
        choices: [
          { name: "Keep real workspace version", value: "keep_real", description: "Leave your real file unchanged." },
          { name: "Apply shadow version", value: "apply_shadow", description: "Overwrite the real file with the shadow result." },
          { name: "Save shadow version aside", value: "save_shadow", description: "Keep the real file and save the shadow file under .agent/conflicts." },
          { name: "Cancel", value: "cancel", description: "Leave apply-back blocked." }
        ]
      });
      return { handled: true, choice };
    }
  };
}
