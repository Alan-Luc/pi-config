import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerReviewEnforcement } from "./review-enforcement.ts";
import { registerGitGuard } from "./git-guard.ts";

export default function (pi: ExtensionAPI): void {
	registerGitGuard(pi);
	registerReviewEnforcement(pi);
}
