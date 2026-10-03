import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NVIM_TERMINAL_MARKER = "PI_NVIM_TERMINAL";
const NVIM_TERMINAL_MARKER_VALUE = "1";

function notifyKitty(title: string, body: string): void {
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

export default function(pi: ExtensionAPI): void {
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode !== "tui" || process.env[NVIM_TERMINAL_MARKER] !== NVIM_TERMINAL_MARKER_VALUE) return;
    notifyKitty("Pi", "Ready for input");
  });
}
