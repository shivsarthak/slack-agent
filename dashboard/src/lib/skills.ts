import path from "node:path";
import { agentPaths } from "@/lib/paths";

/**
 * Resolve a skill filename to a path inside the Skills directory, or null.
 * Basename only, `.md` only — the API never walks outside the directory.
 */
export function safeSkillPath(name: string): string | null {
  const base = path.basename(name.endsWith(".md") ? name : `${name}.md`);
  if (base !== name && base !== `${name}.md`) return null;
  if (base.startsWith(".") || base === ".md" || /[/\\]/.test(base)) return null;
  return path.join(agentPaths().skillsDir, base);
}
