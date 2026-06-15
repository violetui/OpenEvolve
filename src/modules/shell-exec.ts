import { spawn } from "node:child_process";
import type { AgentModule } from "../core/module";

const BLOCKED_PREFIXES: Array<{ pattern: string; reason: string }> = [
  { pattern: "rm -rf /", reason: "destructive recursive delete on root" },
  { pattern: "rm -fr /", reason: "destructive recursive delete on root" },
  { pattern: "sudo ", reason: "privilege escalation" },
  { pattern: "doas ", reason: "privilege escalation" },
  { pattern: "dd if=", reason: "raw device write" },
  { pattern: "mkfs.", reason: "filesystem format" },
  { pattern: "chmod -R 000 /", reason: "destructive permission change" },
  { pattern: "> /dev/sda", reason: "raw device write" },
  { pattern: "> /dev/nvme", reason: "raw device write" },
  { pattern: "shutdown", reason: "system shutdown" },
  { pattern: "reboot", reason: "system reboot" },
  { pattern: "poweroff", reason: "system poweroff" },
  { pattern: "init 0", reason: "system shutdown" },
  { pattern: "init 6", reason: "system reboot" },
  { pattern: "iptables", reason: "firewall modification" },
  { pattern: "ufw ", reason: "firewall modification" },
  { pattern: "passwd ", reason: "password modification" },
  { pattern: "chown ", reason: "ownership change" },
];

const MAX_OUTPUT_BYTES = 100_000;

function isCommandBlocked(command: string): string | null {
  const trimmed = command.trim();
  for (const { pattern, reason } of BLOCKED_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(pattern)) {
      return `${reason} (matches: "${pattern}")`;
    }
  }
  return null;
}

export const ShellExecModule: AgentModule = {
  name: "shell-exec",

  start(ctx) {
    ctx.bus.subscribe("shell.exec.requested", async (event) => {
      const { command, timeout, workdir } = event.payload;
      const effectiveTimeout = Math.min(timeout ?? 120_000, 600_000);
      const cwd = workdir ?? process.cwd();

      console.log(`[shell-exec] Running: ${command.substring(0, 200)}`);

      try {
        const blocked = isCommandBlocked(command);
        if (blocked) {
          throw new Error(`Command blocked: ${blocked}`);
        }

        const result = await executeCommand(command, effectiveTimeout, cwd);

        await ctx.bus.publish({
          type: "shell.exec.completed",
          source: "shell-exec",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            command,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          },
        });

        console.log(`[shell-exec] Completed (exit: ${result.exitCode}, ${result.timedOut ? "timeout" : "ok"})`);
      } catch (error) {
        await ctx.bus.publish({
          type: "shell.exec.completed",
          source: "shell-exec",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            command,
            stdout: "",
            stderr: "",
            exitCode: -1,
            timedOut: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  },
};

function executeCommand(
  cmd: string,
  timeoutMs: number,
  cwd: string,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }, 2000);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) {
          stdout = stdout.substring(0, MAX_OUTPUT_BYTES) + "\n... [output truncated]";
        }
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += chunk.toString();
        if (stderr.length > MAX_OUTPUT_BYTES) {
          stderr = stderr.substring(0, MAX_OUTPUT_BYTES) + "\n... [output truncated]";
        }
      }
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: exitCode ?? -1, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
