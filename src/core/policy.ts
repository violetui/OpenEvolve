/**
 * Security Policy: Restrict modifiable file paths
 *
 * Minimum allowed modification scope:
 *   src/modules/agent-runtime.ts
 *   src/modules/tool-router.ts
 *   src/modules/skill-loader.ts
 *   skills/**
 *   tests/**
 *
 * Forbidden modifications:
 *   core/event-bus.ts
 *   core/policy.ts
 *   supervisor/**
 *   evolution/**
 *   package.json
 *   bun.lock
 */

const ALLOWED_PREFIXES = [
  "src/",
  "skills/",
  "tests/",
];

const FORBIDDEN_PATHS = [
  "src/core/event-bus.ts",
  "src/core/policy.ts",
  "supervisor/",
  "evolution/",
  "package.json",
  "bun.lock",
];

export function isPathAllowed(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  const clean = normalized.replace(/^\.\/|^\/+/, "");

  for (const forbidden of FORBIDDEN_PATHS) {
    if (clean === forbidden || clean.startsWith(forbidden)) {
      return false;
    }
  }

  for (const prefix of ALLOWED_PREFIXES) {
    if (clean === prefix || clean.startsWith(prefix)) {
      return true;
    }
  }

  return false;
}

// ===== External Feature Install Level Policy =====

/**
 * Level 1: Skills/prompts only            → Auto-install allowed
 * Level 2: Read-only plugins               → Requires eval approval
 * Level 3: External API-calling tools      → Requires human approval or strict sandbox
 * Level 4: File-write/command-exec tools   → Auto-install blocked by default
 */
export type InstallLevel = 1 | 2 | 3 | 4;

/**
 * Determine if the given install level allows auto-install
 *
 * Level 1: Auto-install allowed
 * Level 2: Requires eval approval
 * Level 3: Requires human approval or strict sandbox
 * Level 4: Auto-install blocked by default
 */
export function canAutoInstall(level: InstallLevel): boolean {
  return level === 1;
}

export function needsEvalApproval(level: InstallLevel): boolean {
  return level === 2;
}

export function needsHumanApproval(level: InstallLevel): boolean {
  return level === 3 || level === 4;
}

export function isInstallBlocked(level: InstallLevel): boolean {
  return level === 4;
}
export function classifyInstallLevel(permissions: {
  network?: string[];
  filesystem?: { read?: string[]; write?: string[] };
  exec?: string[];
}): InstallLevel {
  // Check for filesystem write permissions
  if (permissions.filesystem?.write && permissions.filesystem.write.length > 0) {
    return 4;
  }

  // Check for command execution permissions
  if (permissions.exec && permissions.exec.length > 0) {
    return 4;
  }

  // Check for network access permissions
  if (permissions.network && permissions.network.length > 0) {
    return 3;
  }

  // Check for filesystem read permissions
  if (permissions.filesystem?.read && permissions.filesystem.read.length > 0) {
    return 2;
  }

  // No special permissions — Level 1
  return 1;
}

/**
 * Calculate the final score for a feature candidate
 *
 * final_score =
 *   usefulness * 0.3
 * + frequency * 0.2
 * + integration * 0.15
 * + security * 0.2
 * + maintenance * 0.1
 * + novelty * 0.05
 */
export function calculateFeatureScore(scores: {
  usefulness: number;
  frequency: number;
  integration: number;
  security: number;
  maintenance: number;
  novelty: number;
  overlap: number;
}): number {
  return (
    scores.usefulness * 0.3 +
    scores.frequency * 0.2 +
    scores.integration * 0.15 +
    scores.security * 0.2 +
    scores.maintenance * 0.1 +
    scores.novelty * 0.05
  );
}

/**
 * Default threshold for feature candidate approval
 */
export const FEATURE_SCORE_THRESHOLD = 0.6;
