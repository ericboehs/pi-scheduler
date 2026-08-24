/**
 * Headless execution of one durable task.
 *
 * A scheduled run is a fresh, isolated `pi -p` process, never a message into an
 * existing session: pi appends to session JSONL without locking, so writing
 * into a session that might be open in a terminal risks interleaved entries.
 * Isolation also means the run cannot inherit whatever model or context a
 * human happened to leave in a session three days ago.
 *
 * Discovery is on by default — the same extensions, skills, prompt templates
 * and AGENTS.md an interactive pi would load — because a scheduled prompt
 * should behave like the pi you would have typed it into. That is also what
 * makes `/checkin` work as a scheduled prompt. `without` strips pieces back
 * out. Themes are always off: there is no TUI to theme.
 */

import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";

import {
  DEFAULT_TIMEOUT_MS,
  type DurableTask,
  enabledFeatures,
  type RunStatus,
  truncate,
} from "./task-registry.ts";

export interface RunOutcome {
  status: RunStatus;
  exitCode?: number;
  output: string;
  error?: string;
}

const MAX_CAPTURED_OUTPUT = 200_000;
const DELIVERY_TIMEOUT_MS = 120_000;

export function piArgsFor(task: DurableTask): string[] {
  const enabled = enabledFeatures(task);
  // Always off: a headless run has no TUI, and saving a session for something
  // that runs unattended every day would grow a session file forever.
  const args = ["-p", "--no-session", "--no-themes"];
  if (!enabled.has("extensions")) args.push("--no-extensions");
  if (!enabled.has("skills")) args.push("--no-skills");
  if (!enabled.has("templates")) args.push("--no-prompt-templates");
  if (!enabled.has("context")) args.push("--no-context-files");
  if (!enabled.has("tools")) args.push("--no-tools");
  if (task.model) args.push("--model", task.model);
  return args;
}

interface CaptureResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  /** A write to the child's stdin failed, so `input` may be only partly there. */
  stdinError?: Error;
}

function capture(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string; timeoutMs: number },
): Promise<CaptureResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Its own process group, so a timeout can kill the whole tree. A prompt
      // that shells out, or a `deliver` one-liner with a pipeline in it, leaves
      // grandchildren holding the stdio pipes: signalling only the direct child
      // leaves 'close' waiting on them long past the deadline.
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let truncated = false;
    let settled = false;
    let stdinError: Error | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Cancel the timeout and the kill escalation.
     *
     * Not housekeeping: a child that dies promptly on SIGTERM would otherwise
     * be followed five seconds later by `kill(-pid, SIGKILL)` against a pid the
     * OS may have handed to something else. `unref` hides this in the CLI, but
     * an in-process `/schedule run` keeps the loop alive long enough to fire.
     */
    const stopTimers = () => {
      if (timer) clearTimeout(timer);
      if (hardTimer) clearTimeout(hardTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      timer = undefined;
      hardTimer = undefined;
      giveUpTimer = undefined;
    };

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      stopTimers();
      resolve({ code, signal, stdout, stderr, timedOut, truncated, stdinError });
    };

    const signalTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // The group is already gone, or this platform refused it.
        child.kill(signal);
      }
    };

    timer = setTimeout(() => {
      timedOut = true;
      signalTree("SIGTERM");
      // A wedged model call ignores SIGTERM; do not let a stuck run hold its
      // claim until CLAIM_STALE_MS expires. If even SIGKILL leaves something
      // holding the pipes, give up waiting and report what we have.
      hardTimer = setTimeout(() => {
        signalTree("SIGKILL");
        giveUpTimer = setTimeout(() => finish(null, "SIGKILL"), 1_000);
        giveUpTimer.unref?.();
      }, 5_000);
      hardTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) stdout += chunk.toString();
      else truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURED_OUTPUT) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stopTimers();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      finish(code, signal);
    });

    // A child that exits, or never reads stdin, makes this write fail with
    // EPIPE. An unhandled 'error' on the stream would take down the whole
    // process — for the tick, that means one misbehaving task killing the run
    // of every other due task. So it is recorded rather than thrown, and the
    // caller decides: a `deliver` one-liner that ignores stdin is fine, a pi
    // run that never received its prompt is not.
    child.stdin.on("error", (error: Error) => {
      stdinError ??= error;
    });

    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

/**
 * The directory the run should happen in.
 *
 * A task records the directory it was created in, so project extensions and
 * AGENTS.md resolve the way they did when the prompt was written. A directory
 * that has since been deleted falls back to $HOME; one that exists but cannot
 * be used is an error, because running a tool-enabled prompt against the wrong
 * project and reporting success is worse than not running it.
 */
function resolveCwd(task: DurableTask): { cwd: string } | { error: string } {
  if (!task.cwd) return { cwd: homedir() };
  try {
    if (!statSync(task.cwd).isDirectory()) return { error: `cwd ${task.cwd} is not a directory` };
    return { cwd: task.cwd };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { cwd: homedir() };
    return { error: `cannot use cwd ${task.cwd}: ${code ?? String(error)}` };
  }
}

/**
 * Run the task's prompt and, if it has one, its delivery command.
 *
 * The prompt goes in on stdin rather than argv so it never appears in `ps`
 * output, and the same is true of the result handed to `deliver`.
 */
export async function runTask(
  task: DurableTask,
  options: { piBin?: string; env?: NodeJS.ProcessEnv; deliveryTimeoutMs?: number } = {},
): Promise<RunOutcome> {
  const piBin = options.piBin ?? process.env.PI_SCHEDULER_PI_BIN ?? "pi";
  const env = options.env ?? process.env;
  const resolved = resolveCwd(task);
  if ("error" in resolved) return { status: "error", output: "", error: resolved.error };
  const cwd = resolved.cwd;
  const timeoutMs = task.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result: CaptureResult;
  try {
    result = await capture(piBin, piArgsFor(task), {
      cwd,
      env,
      input: task.prompt,
      timeoutMs,
    });
  } catch (error) {
    return {
      status: "error",
      output: "",
      error: `could not start ${piBin}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const output = result.truncated
    ? `${result.stdout.trim()}\n\n… output truncated at ${MAX_CAPTURED_OUTPUT} characters`
    : result.stdout.trim();
  if (result.timedOut) {
    return { status: "timeout", output, error: `no result within ${timeoutMs}ms` };
  }
  // The prompt goes in on stdin, so a broken pipe means pi may have run on a
  // partial prompt — or none at all. Reporting that as success would hand back
  // an answer to a question that was never fully asked.
  if (result.stdinError) {
    return {
      status: "error",
      exitCode: result.code ?? undefined,
      output,
      error: `could not send the prompt to ${piBin}: ${result.stdinError.message}`,
    };
  }
  if (result.code !== 0) {
    return {
      status: "error",
      exitCode: result.code ?? undefined,
      output,
      error: truncate(result.stderr.trim() || `pi exited ${result.code ?? result.signal}`, 2_000),
    };
  }

  if (!task.deliver) return { status: "ok", exitCode: 0, output };

  // Empty output is a successful no-op, not something to page about.
  if (!output) return { status: "ok", exitCode: 0, output };

  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  let delivery: CaptureResult;
  try {
    delivery = await capture("/bin/sh", ["-c", task.deliver], {
      cwd,
      env: { ...env, PI_SCHEDULER_OUTPUT: output, PI_SCHEDULER_TASK: task.name ?? task.id },
      input: output,
      timeoutMs: deliveryTimeoutMs,
    });
  } catch (error) {
    return {
      status: "error",
      output,
      error: `deliver failed to start: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (delivery.timedOut) {
    return {
      status: "error",
      output,
      error: `deliver did not finish within ${deliveryTimeoutMs}ms and was killed`,
    };
  }
  if (delivery.code !== 0) {
    return {
      status: "error",
      exitCode: delivery.code ?? undefined,
      output,
      error: truncate(
        delivery.stderr.trim() || `deliver exited ${delivery.code ?? delivery.signal}`,
        2_000,
      ),
    };
  }

  return { status: "ok", exitCode: 0, output };
}
