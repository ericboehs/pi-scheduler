/**
 * The durable task registry behind `/schedule`.
 *
 * Sessions are conversation trees appended without file locking, so scheduled
 * work cannot live in them: a headless run and an open TUI would race on the
 * same JSONL. Durable tasks therefore get their own small store, outside any
 * session, that both the `/schedule` command and the headless runner
 * (bin/pi-scheduler) read and write under a lock.
 *
 * Layout, all mode 0700/0600 because prompts and run output routinely contain
 * private data:
 *
 *   ~/.pi/agent/scheduler/
 *     tasks.json          the registry (atomically replaced)
 *     tasks.json.lock/    a mkdir mutex held only across read-modify-write
 *     runs/<id>.jsonl     per-task run history, newest last
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

import {
  MIN_INTERVAL_MS,
  type Schedule,
  type ScheduleKind,
  advanceSchedule,
  describeSchedule,
  formatDuration,
  parseClock,
  parseCron,
} from "./schedule-core.ts";

export const REGISTRY_VERSION = 1;
export const MAX_DURABLE_TASKS = 100;

/** Default catch-up window. The Mac sleeps; a 3:30pm task should still run at 4. */
export const DEFAULT_MISFIRE_GRACE_MS = 7_200_000;
export const DEFAULT_TIMEOUT_MS = 900_000;

/** How long a claim may look alive before the runner is presumed dead. */
export const CLAIM_STALE_MS = 6 * 3_600_000;

const LOCK_STALE_MS = 60_000;

export const RUN_STATUSES = ["ok", "error", "timeout", "skipped"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * `skip` never runs late, `always` always does, and a number is the grace
 * window in milliseconds past `nextRunAt` within which a late run is still
 * wanted. Late runs coalesce: one catch-up, never a replay of every slot.
 */
export type MisfirePolicy = "skip" | "always" | number;

/**
 * Discovery a scheduled run can switch off.
 *
 * The default is everything on, because a scheduled run should behave like the
 * pi you would have typed the prompt into: your extensions, your skills, your
 * prompt templates, the project's AGENTS.md. Full discovery costs roughly 0.3s
 * more at startup, which is nothing for something that runs once a day.
 *
 * Themes are deliberately absent: a headless run has no TUI to theme, so the
 * flag would be a knob that does nothing.
 */
export const FEATURES = ["extensions", "skills", "templates", "context", "tools"] as const;
export type Feature = (typeof FEATURES)[number];

/**
 * Parse a `--with` / `--without` list. Returns an error string rather than
 * throwing, so both the slash command and the CLI can report it the same way.
 */
export function parseFeatures(input: string): { features: Feature[] } | { error: string } {
  const requested = input
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  if (requested.length === 0) return { error: `wants ${FEATURES.join(", ")}, or all / none` };

  const features = new Set<Feature>();
  for (const item of requested) {
    if (item === "all") {
      for (const feature of FEATURES) features.add(feature);
      continue;
    }
    if (item === "none") continue;
    const match = FEATURES.find(
      (feature) => feature === item || `${feature}s` === item || feature === `${item}s`,
    );
    if (!match) {
      return { error: `does not know "${item}"; try ${FEATURES.join(", ")}, all or none` };
    }
    features.add(match);
  }
  return { features: FEATURES.filter((feature) => features.has(feature)) };
}

/**
 * What this task actually runs with: everything, less whatever it turned off.
 *
 * `enable` is the older, inverted field, from when scheduled runs defaulted to
 * a bare pi. Honour it if a registry predates the switch, so a task written
 * then does not silently gain tools it was never given.
 */
export function enabledFeatures(task: DurableTask): Set<Feature> {
  if (task.without === undefined && task.enable !== undefined) {
    const legacy = new Set<Feature>(task.enable);
    if (task.tools) legacy.add("tools");
    return legacy;
  }
  const off = new Set<Feature>(task.without ?? []);
  return new Set(FEATURES.filter((feature) => !off.has(feature)));
}

export interface DurableTask extends Schedule {
  id: string;
  name?: string;
  prompt: string;
  /** Model pattern as pi's --model takes it, e.g. "cerebras/gpt-oss-120b:low". */
  model?: string;
  cwd?: string;
  /** Legacy: superseded by `without`. Kept so a task written before the flip still runs. */
  tools?: boolean;
  /**
   * Discovery switched off for this run. Absent or empty means a full pi — the
   * same extensions, skills, templates and AGENTS.md you get interactively.
   */
  without?: Feature[];
  /** Legacy inverted form of `without`, from when runs defaulted to a bare pi. */
  enable?: Feature[];
  /** Shell command receiving the run output on stdin and in $PI_SCHEDULER_OUTPUT. */
  deliver?: string;
  misfire?: MisfirePolicy;
  timeoutMs?: number;
  paused?: boolean;
  createdAt: number;
  nextRunAt: number;
  lastRunAt?: number;
  lastStatus?: RunStatus;
  /** Set while a runner owns this task, so overlapping minute checks do not double-run it. */
  runningSince?: number;
  runnerPid?: number;
  /**
   * The machine that wrote the claim.
   *
   * `runnerPid` is only meaningful on the host that produced it. Without this,
   * a second machine sharing the registry probes a pid from the first, gets
   * ESRCH for a runner that is very much alive, and runs the task again.
   */
  runnerHost?: string;
}

export interface Registry {
  version: number;
  tasks: DurableTask[];
  /**
   * Entries that failed validation, carried through untouched.
   *
   * They are never scheduled, never matched by name, and never counted — but
   * `writeRegistry` puts them back, so a task this version cannot parse (a
   * hand-edit, a half-written line, a field from a newer release) survives
   * instead of being deleted by whatever `add` happens to run next.
   */
  quarantined?: unknown[];
}

export interface RunRecord {
  runId: string;
  startedAt: number;
  endedAt: number;
  status: RunStatus;
  exitCode?: number;
  scheduledFor?: number;
  error?: string;
  /** Truncated; the point is a glanceable history, not an archive. */
  output?: string;
}

export const MAX_RECORDED_OUTPUT = 4_000;
export const MAX_RUN_LOG_RECORDS = 200;
export const MAX_RUN_LOG_BYTES = 1_000_000;

export function schedulerDir(): string {
  return process.env.PI_SCHEDULER_DIR
    ?? join(process.env.PI_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "scheduler");
}

export function registryPath(): string {
  return join(schedulerDir(), "tasks.json");
}

function runsPath(taskId: string): string {
  return join(schedulerDir(), "runs", `${taskId}.jsonl`);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Replace a file atomically and privately. The chmod is on the temp file, so
 * the contents are never briefly world-readable under a restrictive umask.
 */
function writePrivateAtomic(path: string, contents: string): void {
  ensureDir(dirname(path));
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, contents, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

function appendPrivate(path: string, line: string): void {
  ensureDir(dirname(path));
  const fd = openSync(path, "a", 0o600);
  try {
    writeSync(fd, line);
  } finally {
    closeSync(fd);
  }
}

export function emptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, tasks: [] };
}

export const SCHEDULE_KINDS = ["interval", "daily", "once", "cron"] as const;

export function isDurableTask(value: unknown): value is DurableTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Partial<DurableTask>;
  if (
    typeof task.id !== "string" ||
    !task.id ||
    !SCHEDULE_KINDS.includes(task.kind as ScheduleKind) ||
    typeof task.prompt !== "string" ||
    !task.prompt.trim() ||
    !Number.isFinite(task.createdAt) ||
    !Number.isFinite(task.nextRunAt)
  ) {
    return false;
  }
  // A non-positive timeout would make every run time out before it started.
  if (task.timeoutMs !== undefined && (!Number.isFinite(task.timeoutMs) || task.timeoutMs <= 0)) return false;
  // A numeric misfire policy is a grace window; NaN/Infinity/negatives are not.
  if (task.misfire !== undefined && task.misfire !== "skip" && task.misfire !== "always"
    && (typeof task.misfire !== "number" || !Number.isFinite(task.misfire) || task.misfire < 0)) {
    return false;
  }
  // A claim is both fields or neither; half of one is a torn write.
  if ((task.runningSince === undefined) !== (task.runnerPid === undefined)) return false;
  if (task.runningSince !== undefined && !Number.isFinite(task.runningSince)) return false;
  // Optional, and deliberately not required even alongside a claim: a registry
  // written by an older version has claims without it. Quarantining those
  // would make an upgrade look like the tasks had vanished.
  if (task.runnerHost !== undefined && typeof task.runnerHost !== "string") return false;

  if (task.kind === "interval") {
    return typeof task.intervalMs === "number" && task.intervalMs >= MIN_INTERVAL_MS;
  }
  if (task.kind === "daily") {
    return typeof task.dailyAt === "string" && parseClock(task.dailyAt) !== undefined;
  }
  if (task.kind === "cron") {
    return typeof task.cronExpr === "string" && parseCron(task.cronExpr) !== undefined;
  }
  return true;
}

/**
 * Raised when tasks.json exists but cannot be trusted.
 *
 * This is deliberately not swallowed. "Unreadable" used to read as "empty",
 * which is survivable for a tick that finds nothing to do but catastrophic for
 * the next `add` or `edit`: it would write an empty-plus-one registry over a
 * file full of perfectly good tasks. A missing file is the only condition that
 * legitimately means "no tasks".
 */
export class RegistryUnreadableError extends Error {
  constructor(reason: string) {
    super(`Cannot read ${registryPath()}: ${reason}. Nothing was changed; fix or move the file aside.`);
    this.name = "RegistryUnreadableError";
  }
}

/**
 * Read the registry. A missing file is an empty registry; anything else that
 * goes wrong throws. Individual malformed tasks are still dropped rather than
 * failing the whole file, since one bad entry should not strand the others.
 */
export function readRegistry(): Registry {
  let raw: string;
  try {
    raw = readFileSync(registryPath(), "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return emptyRegistry();
    throw new RegistryUnreadableError(code ?? String(error));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RegistryUnreadableError(error instanceof Error ? error.message : "invalid JSON");
  }

  const candidate = parsed as Partial<Registry>;
  if (candidate?.version !== REGISTRY_VERSION) {
    throw new RegistryUnreadableError(`version ${String(candidate?.version)} is not ${REGISTRY_VERSION}`);
  }
  if (!Array.isArray(candidate.tasks)) {
    throw new RegistryUnreadableError("tasks is not an array");
  }
  const tasks = candidate.tasks.filter(isDurableTask);
  const quarantined = candidate.tasks.filter((task) => !isDurableTask(task));
  if (quarantined.length > 0) {
    // Kept, not dropped — but still worth saying, because they are inert and
    // the user is presumably wondering where their task went.
    process.emitWarning(
      `Ignoring ${quarantined.length} malformed task(s) in ${registryPath()}.`
      + ` They stay in the file but will not run; fix or delete them by hand.`,
    );
  }
  return { version: REGISTRY_VERSION, tasks, quarantined };
}

export function writeRegistry(registry: Registry): void {
  // Quarantined entries go back verbatim and last, so a write triggered by an
  // unrelated `add` is not what finally destroys them.
  const tasks = [...registry.tasks, ...(registry.quarantined ?? [])];
  writePrivateAtomic(
    registryPath(),
    `${JSON.stringify({ version: REGISTRY_VERSION, tasks }, undefined, 2)}\n`,
  );
}

function lockPath(): string {
  return `${registryPath()}.lock`;
}

function lockAgeMs(): number | undefined {
  try {
    return Date.now() - statSync(lockPath()).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Read-modify-write the registry under a mkdir mutex.
 *
 * mkdir is the one filesystem primitive that is atomic on every macOS
 * filesystem including network volumes. It is held for the JSON round trip
 * plus whatever the caller does inside `mutate` — `check` also compacts run
 * logs there, which is the longest critical section. The actual agent run
 * happens outside it, guarded instead by the claim fields on the task.
 */
export function withRegistry<T>(mutate: (registry: Registry) => T): T {
  ensureDir(schedulerDir());
  const path = lockPath();

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = lockAgeMs();
      if (age !== undefined && age > LOCK_STALE_MS) {
        // The holder died mid-write. The registry itself is only ever replaced
        // by rename, so the worst case is a lost concurrent edit, not a torn file.
        rmSync(path, { recursive: true, force: true });
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      continue;
    }

    // A `process.exit` from inside `mutate` would skip the finally below and
    // strand this lock for the full stale window, blocking every other
    // invocation. Belt and braces: release it on the way out too.
    const release = () => rmSync(path, { recursive: true, force: true });
    process.once("exit", release);
    try {
      return mutate(readRegistry());
    } finally {
      process.removeListener("exit", release);
      release();
    }
  }

  throw new Error(`Could not lock ${path}; remove it if no scheduler is running`);
}

export function makeTaskId(existing: DurableTask[]): string {
  const used = new Set(existing.map((task) => task.id));
  let id: string;
  do {
    id = randomBytes(4).toString("hex");
  } while (used.has(id));
  return id;
}

export function findTasks(tasks: DurableTask[], selector: string): DurableTask[] {
  const needle = selector.toLowerCase();
  const byName = tasks.filter((task) => task.name?.toLowerCase() === needle);
  if (byName.length > 0) return byName;
  return tasks.filter((task) => task.id.startsWith(needle));
}

/**
 * Whether `name` collides with an existing task, compared case-insensitively
 * because `findTask` resolves names that way: `Grades` alongside `grades`
 * would make both permanently ambiguous.
 */
export function nameTaken(tasks: DurableTask[], name: string, exceptId?: string): boolean {
  const needle = name.toLowerCase();
  return tasks.some((task) => task.id !== exceptId && task.name?.toLowerCase() === needle);
}

export function findTask(tasks: DurableTask[], selector: string): DurableTask {
  const matches = findTasks(tasks, selector);
  const task = matches[0];
  if (!task) throw new Error(`No scheduled task matches ${selector}`);
  if (matches.length > 1) throw new Error(`${selector} is ambiguous: ${matches.map((m) => m.id).join(", ")}`);
  return task;
}

export function misfireGraceMs(task: DurableTask): number {
  const policy = task.misfire ?? DEFAULT_MISFIRE_GRACE_MS;
  if (policy === "skip") return 0;
  if (policy === "always") return Number.POSITIVE_INFINITY;
  return typeof policy === "number" && policy >= 0 ? policy : DEFAULT_MISFIRE_GRACE_MS;
}

/**
 * Is the process that claimed this task gone?
 *
 * Signal 0 does no signalling; it just asks the kernel about the pid. ESRCH
 * means nothing has that pid, so the claim is abandoned and can be taken over
 * immediately rather than after the six-hour age rule. EPERM means it exists
 * but belongs to another user, which is still "alive".
 *
 * Only ever used to declare a claim dead *sooner*, and only for claims this
 * machine wrote. A pid from another host means nothing here — probing it would
 * return ESRCH for a runner that is running fine, and two machines would
 * execute the same prompt at once. A pid can also be reused, so a
 * seemingly-live pid proves nothing either and falls through to the age rule.
 */
function runnerIsGone(task: DurableTask): boolean {
  // Undefined has to mean "probe" or claims written before this field existed
  // would never go stale by pid. The cost is that the first claim after an
  // upgrade on a shared volume is unprotected; the age rule still covers it.
  if (task.runnerHost !== undefined && task.runnerHost !== hostname()) return false;
  const pid = task.runnerPid;
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  // Our own pid is the manual-run case: obviously alive, and probing it would
  // always say so anyway.
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function isClaimStale(task: DurableTask, now: number): boolean {
  if (task.runningSince === undefined) return false;
  if (runnerIsGone(task)) return true;
  return now - task.runningSince > (task.timeoutMs ?? DEFAULT_TIMEOUT_MS) + CLAIM_STALE_MS;
}

export interface DueDecision {
  task: DurableTask;
  /** The slot this run belongs to, which is not `now` when catching up. */
  scheduledFor: number;
  /** Late beyond the grace window: advance the schedule, record a skip, run nothing. */
  skip: boolean;
}

/**
 * Which tasks this tick should act on. Pure, so the policy is testable without
 * a filesystem or a clock.
 */
export function selectDue(tasks: DurableTask[], now: number): DueDecision[] {
  const due: DueDecision[] = [];
  for (const task of tasks) {
    if (task.paused) continue;
    if (task.nextRunAt > now) continue;
    if (task.runningSince !== undefined && !isClaimStale(task, now)) continue;
    due.push({
      task,
      scheduledFor: task.nextRunAt,
      skip: now - task.nextRunAt > misfireGraceMs(task),
    });
  }
  return due;
}

/**
 * The task as it should be stored once a run is claimed: whoever holds
 * `runningSince`/`runnerPid` owns the run, and `selectDue` skips the task until
 * the claim is released or goes stale. One-shots are not special here — they
 * are retired by `settleRun` after any completed outcome, success or not.
 *
 * `runnerHost` is stamped alongside the pid because the pid is only meaningful
 * on the machine that produced it.
 */
export function claimTask(task: DurableTask, now: number, pid: number): DurableTask {
  return { ...task, runningSince: now, runnerPid: pid, runnerHost: hostname() };
}

/** Clear the claim and roll the schedule forward past `now`. */
export function releaseTask(
  task: DurableTask,
  now: number,
  status: RunStatus,
): DurableTask | undefined {
  const next = advanceSchedule(task, task.nextRunAt, now);
  const released: DurableTask = {
    ...task,
    lastRunAt: now,
    lastStatus: status,
  };
  delete released.runningSince;
  delete released.runnerPid;
  delete released.runnerHost;
  if (next === undefined) return undefined;
  return { ...released, nextRunAt: next };
}

export function appendRun(taskId: string, record: RunRecord): void {  const trimmed: RunRecord = {
    ...record,
    output: record.output ? truncate(record.output, MAX_RECORDED_OUTPUT) : undefined,
  };
  const path = runsPath(taskId);
  appendPrivate(path, `${JSON.stringify(trimmed)}\n`);

  // Compact only when the log has actually grown, so the common case stays a
  // single append rather than a read-rewrite of the whole history.
  try {
    if (statSync(path).size > MAX_RUN_LOG_BYTES) {
      const kept = readRuns(taskId, MAX_RUN_LOG_RECORDS);
      writePrivateAtomic(path, `${kept.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    }
  } catch {
    // Compaction is housekeeping; never fail a run over it.
  }
}

/**
 * Structural check for a history line.
 *
 * This validates every optional field a caller dereferences, not just the
 * required ones: `runs` does `record.error.split("\n")`, so a line carrying
 * `"error": 42` would pass a shallower check and then throw a TypeError that
 * takes down the whole command — the same "one bad line poisons the history"
 * failure the parse guard above prevents, one layer up.
 */
function isRunRecord(value: unknown): value is RunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RunRecord>;
  if (
    typeof record.runId !== "string"
    || !Number.isFinite(record.startedAt)
    || !Number.isFinite(record.endedAt)
    || !RUN_STATUSES.includes(record.status as RunStatus)
  ) {
    return false;
  }
  if (record.error !== undefined && typeof record.error !== "string") return false;
  if (record.output !== undefined && typeof record.output !== "string") return false;
  if (record.exitCode !== undefined && !Number.isInteger(record.exitCode)) return false;
  if (record.scheduledFor !== undefined && !Number.isFinite(record.scheduledFor)) return false;
  return true;
}

export function readRuns(taskId: string, limit = 20): RunRecord[] {
  let raw: string;
  try {
    raw = readFileSync(runsPath(taskId), "utf8");
  } catch (error) {
    // No history yet is normal. A log that exists but cannot be read is not,
    // and returning [] there would let compaction rewrite it as empty.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = raw.split("\n");
  const records: RunRecord[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // A torn final line is expected after a crash — but that crashed run is
      // usually the one being investigated, so it is still worth naming.
      process.emitWarning(
        index < lines.length - 1
          ? `Skipping unparseable run record in ${runsPath(taskId)} line ${index + 1}`
          : `Skipping the last run record in ${runsPath(taskId)}; likely truncated by a crash`,
      );
      continue;
    }
    if (!isRunRecord(parsed)) {
      process.emitWarning(`Skipping malformed run record in ${runsPath(taskId)} line ${index + 1}`);
      continue;
    }
    records.push(parsed);
  }
  return records.slice(-limit);
}

/** Returns false if a log existed and could not be removed. */
export function forgetRuns(taskId: string): boolean {
  try {
    unlinkSync(runsPath(taskId));
    return true;
  } catch (error) {
    // Nothing recorded yet is the common case and not a failure.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Drop history for tasks that no longer exist, so the directory does not creep.
 *
 * Returns the failures as well as the count: a caller that reports "removed 0"
 * over logs it could not delete is telling the user their private prompts and
 * outputs are gone when they are still on disk.
 */
export function pruneRuns(tasks: DurableTask[]): { removed: number; failed: string[] } {
  const live = new Set(tasks.map((task) => task.id));
  let entries: string[];
  try {
    entries = readdirSync(join(schedulerDir(), "runs"));
  } catch (error) {
    // Nothing recorded yet is the normal case. A runs/ that exists but cannot
    // be listed is not, and "removed 0" would read as "nothing to do".
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, failed: [] };
    throw error;
  }
  let removed = 0;
  const failed: string[] = [];
  for (const entry of entries) {
    const id = entry.endsWith(".jsonl") ? entry.slice(0, -".jsonl".length) : undefined;
    if (id === undefined || live.has(id)) continue;
    if (forgetRuns(id)) removed += 1;
    else failed.push(id);
  }
  return { removed, failed };
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… ${value.length - max} more characters`;
}

export interface RunOutcomeLike {
  status: RunStatus;
  exitCode?: number;
  output?: string;
  error?: string;
}

/**
 * Record a finished run, clear its claim, and roll the schedule forward.
 *
 * Pass `claimedAt` — the `runningSince` this runner wrote when it claimed the
 * task — to settle only if the claim is still ours. Without it a run that went
 * stale, was reclaimed by another runner, and then finished late would clear
 * the new runner's claim and advance the schedule a second time.
 *
 * One-shots have no next occurrence, so they leave the registry here. Their
 * outcome survives in the run log, which is the only place a reminder that
 * failed can still be found.
 */
export function settleRun(
  taskId: string,
  scheduledFor: number,
  startedAt: number,
  outcome: RunOutcomeLike,
  claimedAt?: number,
): void {
  const endedAt = Date.now();
  // Recording history must never be able to strand a claim: a task left
  // "running" is invisible to every later tick until CLAIM_STALE_MS, and a
  // one-shot would never retire. Capture the failure, release, then report it.
  let historyError: unknown;
  try {
    appendRun(taskId, {
      runId: `${startedAt}`,
      startedAt,
      endedAt,
      scheduledFor,
      status: outcome.status,
      exitCode: outcome.exitCode,
      error: outcome.error,
      output: outcome.output || undefined,
    });
  } catch (error) {
    historyError = error;
  }

  withRegistry((registry) => {
    const index = registry.tasks.findIndex((candidate) => candidate.id === taskId);
    if (index < 0) return;
    const current = registry.tasks[index];
    if (!current) return;
    // Only the claim holder may settle. If this run went stale and another
    // runner has since reclaimed the task, that runner owns the schedule now.
    if (claimedAt !== undefined && current.runningSince !== claimedAt) return;
    const released = releaseTask(current, endedAt, outcome.status);
    if (released) registry.tasks[index] = released;
    else registry.tasks.splice(index, 1);
    writeRegistry(registry);
  });

  if (historyError) throw historyError;
}

export function formatTask(task: DurableTask, now = Date.now()): string {
  const label = task.name ? `${task.id} (${task.name})` : task.id;
  const parts = [label, describeSchedule(task)];
  if (task.paused) parts.push("paused");
  else if (task.runningSince !== undefined) parts.push(`running for ${formatDuration(now - task.runningSince)}`);
  else parts.push(`next ${new Date(task.nextRunAt).toLocaleString()}`);
  if (task.model) parts.push(task.model);
  if (task.lastStatus) parts.push(`last ${task.lastStatus}`);
  parts.push(task.prompt.replace(/\s+/g, " ").slice(0, 60));
  return parts.join(" · ");
}
