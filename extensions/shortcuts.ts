import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function shortcuts(pi: ExtensionAPI): void {
  pi.registerShortcut("alt+p", {
    description: "Open permission settings",
    handler: (ctx) => {
      if (!pi.getCommands().some((command) => command.name === "permission-system")) {
        ctx.ui.notify("Permission settings are unavailable: /permission-system is not loaded.", "warning");
        return;
      }

      pi.sendUserMessage("/permission-system", { expandPromptTemplates: true });
    },
  });
}
