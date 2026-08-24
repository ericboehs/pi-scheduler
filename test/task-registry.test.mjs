import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// A pid that is genuinely free: spawn something and wait for it to exit. A
// hardcoded low number is not a substitute — pid 2 is unused on macOS but is
// kthreadd on Linux, which turned "this runner is dead" into "this runner is
// alive" and only failed on one of the two platforms in CI.
async function deadPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.on("exit", resolve));
  return child.pid;
}

// The registry resolves its directory from the environment at call time, so
// every test gets a private scheduler root and none of them touch ~/.pi.
function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sched-"));
  const previous = process.env.PI_SCHEDULER_DIR;
  process.env.PI_SCHEDULER_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_SCHEDULER_DIR;
    else process.env.PI_SCHEDULER_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

const registry = await import("../extensions/lib/task-registry.ts");
const {
  DEFAULT_MISFIRE_GRACE_MS,
  appendRun,
  claimTask,
  findTask,
  forgetRuns,
  formatTask,
  isClaimStale,
  isDurableTask,
  makeTaskId,
  misfireGraceMs,
  pruneRuns,
  readRegistry,
  readRuns,
  registryPath,
  releaseTask,
  selectDue,
  settleRun,
  truncate,
  writeRegistry,
  withRegistry,
} = registry;

function task(overrides = {}) {
  return {
    id: "aaaa1111",
    kind: "daily",
    dailyAt: "15:30",
    prompt: "check grades",
    createdAt: 1_000,
    nextRunAt: 100_000,
    ...overrides,
  };
}

test("an absent registry reads as empty rather than throwing", (t) => {
  withTempDir(t);
  assert.deepEqual(readRegistry(), { version: 1, tasks: [] });
});

test("a corrupt registry refuses to read, so the next write cannot overwrite it", (t) => {
  const dir = withTempDir(t);
  const path = join(dir, "tasks.json");
  writeFileSync(path, "{ this is not json");

  // Reading it as empty was the old behaviour, and it lost data: the next
  // `add` would happily write a one-task registry over a file that might have
  // held twenty perfectly good ones.
  assert.throws(() => readRegistry(), /Cannot read/);
  assert.throws(() => withRegistry(() => {}), /Cannot read/);
  assert.equal(readFileSync(path, "utf8"), "{ this is not json", "the bad file is left alone");
});

test("a registry from a future version is refused rather than silently emptied", (t) => {
  const dir = withTempDir(t);
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({ version: 99, tasks: [task()] }));
  assert.throws(() => readRegistry(), /version 99/);
});

test("an unreadable registry is an error, not an empty one", (t) => {
  const dir = withTempDir(t);
  const path = join(dir, "tasks.json");
  writeFileSync(path, JSON.stringify({ version: 1, tasks: [task()] }));
  chmodSync(path, 0o000);
  // root ignores the mode, so this can only be asserted as an unprivileged user.
  if (process.getuid?.() === 0) return;
  assert.throws(() => readRegistry(), /Cannot read/);
});

test("a malformed task is dropped without discarding its healthy neighbours", (t) => {
  const dir = withTempDir(t);
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [task(), { id: "junk", kind: "weekly", prompt: "x", createdAt: 0, nextRunAt: 0 }],
  }));
  assert.deepEqual(readRegistry().tasks.map((entry) => entry.id), ["aaaa1111"]);
});

test("the registry and its directory are private to the user", (t) => {
  const dir = withTempDir(t);
  writeRegistry({ version: 1, tasks: [task()] });
  assert.equal(statSync(registryPath()).mode & 0o777, 0o600, "prompts are private data");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("validation matches each kind against the field it actually needs", () => {
  assert.equal(isDurableTask(task()), true);
  assert.equal(isDurableTask(task({ dailyAt: "25:00" })), false);
  assert.equal(isDurableTask(task({ kind: "interval", intervalMs: 30_000 })), false, "below the 1m floor");
  assert.equal(isDurableTask(task({ kind: "interval", intervalMs: 60_000 })), true);
  assert.equal(isDurableTask(task({ kind: "cron", cronExpr: "99 * * * *" })), false);
  assert.equal(isDurableTask(task({ kind: "cron", cronExpr: "@daily" })), true);
  assert.equal(isDurableTask(task({ kind: "once", dailyAt: undefined })), true);
  assert.equal(isDurableTask(task({ prompt: "   " })), false, "an empty prompt is not a task");
  assert.equal(isDurableTask(task({ timeoutMs: 0 })), false, "a zero timeout kills every run instantly");
  assert.equal(isDurableTask(task({ misfire: -1 })), false);
  assert.equal(isDurableTask(task({ misfire: Number.NaN })), false);
  assert.equal(isDurableTask(task({ misfire: "always" })), true);
  assert.equal(isDurableTask(task({ misfire: "soon" })), false);
  assert.equal(isDurableTask(task({ nextRunAt: Number.NaN })), false);
  assert.equal(
    isDurableTask(task({ runningSince: Date.now() })),
    false,
    "half a claim is a torn write, not an owned run",
  );
  assert.equal(isDurableTask(task({ runningSince: Date.now(), runnerPid: 42 })), true);
  assert.equal(isDurableTask(null), false);
});

test("withRegistry round-trips an edit through the lock", (t) => {
  withTempDir(t);
  withRegistry((current) => {
    current.tasks.push(task());
    writeRegistry(current);
  });
  assert.deepEqual(readRegistry().tasks.map((entry) => entry.id), ["aaaa1111"]);
});

test("a stale lock left by a dead writer is broken rather than waited on", (t) => {
  const dir = withTempDir(t);
  writeRegistry({ version: 1, tasks: [] });

  const { mkdirSync: makeDir, utimesSync: touch } = { mkdirSync, utimesSync };
  const lock = join(dir, "tasks.json.lock");
  makeDir(lock, { mode: 0o700 });
  const ancient = new Date(Date.now() - 600_000);
  touch(lock, ancient, ancient);

  withRegistry((current) => {
    current.tasks.push(task());
    writeRegistry(current);
  });
  assert.equal(readRegistry().tasks.length, 1);
});

test("ids are unique against what is already stored", () => {
  const existing = [task({ id: "aa" }), task({ id: "bb" })];
  const id = makeTaskId(existing);
  assert.ok(!["aa", "bb"].includes(id));
  assert.match(id, /^[0-9a-f]{8}$/);
});

test("tasks are selected by name first, then by id prefix", () => {
  const tasks = [task({ id: "abc12345", name: "grades" }), task({ id: "abd99999" })];
  assert.equal(findTask(tasks, "grades").id, "abc12345");
  assert.equal(findTask(tasks, "abc").id, "abc12345");
  assert.throws(() => findTask(tasks, "ab"), /ambiguous/);
  assert.throws(() => findTask(tasks, "zzz"), /No scheduled task matches/);
});

test("misfire policies translate into a grace window", () => {
  assert.equal(misfireGraceMs(task()), DEFAULT_MISFIRE_GRACE_MS);
  assert.equal(misfireGraceMs(task({ misfire: "skip" })), 0);
  assert.equal(misfireGraceMs(task({ misfire: "always" })), Number.POSITIVE_INFINITY);
  assert.equal(misfireGraceMs(task({ misfire: 7_200_000 })), 7_200_000);
});

test("selectDue ignores anything not actually runnable now", () => {
  const now = 200_000;
  assert.deepEqual(selectDue([task({ nextRunAt: now + 1 })], now), [], "not due yet");
  assert.deepEqual(selectDue([task({ paused: true })], now), [], "paused");
  assert.deepEqual(selectDue([task({ runningSince: now - 1_000 })], now), [], "already claimed");
  assert.equal(selectDue([task()], now).length, 1);
});

test("a late run inside the grace window still runs, once", () => {
  const scheduledFor = 100_000;
  const decisions = selectDue([task({ nextRunAt: scheduledFor })], scheduledFor + 3_600_000);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].skip, false, "an hour late is inside the default 2h window");
  assert.equal(decisions[0].scheduledFor, scheduledFor, "the run belongs to its own slot, not to now");
});

test("a run later than the grace window is skipped, not replayed", () => {
  const scheduledFor = 100_000;
  const decisions = selectDue([task({ nextRunAt: scheduledFor })], scheduledFor + 10_800_000);
  assert.equal(decisions[0].skip, true, "three hours late is past the default window");

  const strict = selectDue([task({ nextRunAt: scheduledFor, misfire: "skip" })], scheduledFor + 1);
  assert.equal(strict[0].skip, true);

  const always = selectDue([task({ nextRunAt: scheduledFor, misfire: "always" })], scheduledFor + 86_400_000);
  assert.equal(always[0].skip, false);
});

test("a claim from a runner that died is reclaimed after the stale window", () => {
  const now = 1_000_000_000;
  const fresh = task({ runningSince: now - 1_000 });
  assert.equal(isClaimStale(fresh, now), false);
  assert.equal(selectDue([fresh], now).length, 0);

  const abandoned = task({ runningSince: now - 86_400_000 });
  assert.equal(isClaimStale(abandoned, now), true);
  assert.equal(selectDue([abandoned], now).length, 1, "otherwise it would never run again");
});

test("claiming marks ownership and releasing rolls the schedule forward", () => {
  const now = new Date(2026, 7, 22, 15, 30).getTime();
  const claimed = claimTask(task(), now, 4242);
  assert.equal(claimed.runningSince, now);
  assert.equal(claimed.runnerPid, 4242);

  const released = releaseTask(claimed, now + 5_000, "ok");
  assert.equal(released.runningSince, undefined);
  assert.equal(released.runnerPid, undefined);
  assert.equal(released.lastStatus, "ok");
  assert.equal(new Date(released.nextRunAt).getDate(), 23, "tomorrow at 15:30");
});

test("releasing a one-shot retires it, since there is no next occurrence", () => {
  assert.equal(releaseTask(task({ kind: "once" }), 1, "ok"), undefined);
});

test("run history is appended, private, and read back newest-last", (t) => {
  const dir = withTempDir(t);
  appendRun("abc", { runId: "1", startedAt: 1, endedAt: 2, status: "ok", output: "first" });
  appendRun("abc", { runId: "2", startedAt: 3, endedAt: 4, status: "error", error: "boom" });

  const records = readRuns("abc");
  assert.deepEqual(records.map((entry) => entry.status), ["ok", "error"]);
  assert.equal(statSync(join(dir, "runs", "abc.jsonl")).mode & 0o777, 0o600, "output can contain anything");
  assert.deepEqual(readRuns("nobody"), []);
});

test("a torn final line from a crash does not poison the history", (t) => {
  const dir = withTempDir(t);
  appendRun("abc", { runId: "1", startedAt: 1, endedAt: 2, status: "ok" });
  writeFileSync(join(dir, "runs", "abc.jsonl"), `${readFileSync(join(dir, "runs", "abc.jsonl"), "utf8")}{"runId":"2"`);
  assert.equal(readRuns("abc").length, 1);
});

test("recorded output is capped so history stays glanceable", (t) => {
  withTempDir(t);
  appendRun("abc", { runId: "1", startedAt: 1, endedAt: 2, status: "ok", output: "x".repeat(50_000) });
  const [record] = readRuns("abc");
  assert.ok(record.output.length < 5_000);
  assert.match(record.output, /more characters$/);
});

test("settleRun records the outcome and retires a finished one-shot", (t) => {
  withTempDir(t);
  writeRegistry({ version: 1, tasks: [task({ kind: "once", id: "one11111" })] });

  settleRun("one11111", 100_000, 100_000, { status: "ok", output: "done" });

  assert.deepEqual(readRegistry().tasks, [], "a one-shot leaves the registry once it has run");
  const [record] = readRuns("one11111");
  assert.equal(record.status, "ok");
  assert.equal(record.output, "done");
  assert.equal(record.scheduledFor, 100_000);
});

test("settleRun keeps a recurring task and clears its claim", (t) => {
  withTempDir(t);
  writeRegistry({ version: 1, tasks: [claimTask(task(), Date.now(), 1)] });

  settleRun("aaaa1111", 100_000, Date.now(), { status: "error", error: "pi exited 1" });

  const [stored] = readRegistry().tasks;
  assert.equal(stored.runningSince, undefined, "a stuck claim would hide the task forever");
  assert.equal(stored.lastStatus, "error");
  assert.ok(stored.nextRunAt > Date.now());
  assert.equal(readRuns("aaaa1111")[0].error, "pi exited 1");
});

test("a settle from a runner that was already superseded does not touch the new claim", (t) => {
  withTempDir(t);

  // A goes stale, B reclaims, then A finally finishes. A must not clear B's
  // claim or advance the schedule out from under the run that is still going.
  const staleClaim = Date.now() - 10_000;
  const freshClaim = Date.now();
  writeRegistry({ version: 1, tasks: [claimTask(task(), freshClaim, 2222)] });

  settleRun("aaaa1111", 100_000, staleClaim, { status: "error", error: "late loser" }, staleClaim);

  const [stored] = readRegistry().tasks;
  assert.equal(stored.runningSince, freshClaim, "B still owns the run");
  assert.equal(stored.runnerPid, 2222);
  assert.equal(stored.lastStatus, undefined, "B has not reported yet");
  assert.equal(
    readRuns("aaaa1111")[0].error,
    "late loser",
    "the losing run is still worth recording; only the schedule is off-limits",
  );
});

test("the claim holder settles normally", (t) => {
  withTempDir(t);
  const claimedAt = Date.now();
  writeRegistry({ version: 1, tasks: [claimTask(task(), claimedAt, 2222)] });

  settleRun("aaaa1111", 100_000, claimedAt, { status: "ok" }, claimedAt);

  const [stored] = readRegistry().tasks;
  assert.equal(stored.runningSince, undefined);
  assert.equal(stored.lastStatus, "ok");
});

test("a malformed history line is skipped rather than trusted as a record", (t) => {
  const dir = withTempDir(t);
  mkdirSync(join(dir, "runs"), { recursive: true });
  writeFileSync(join(dir, "runs", "abc.jsonl"), [
    JSON.stringify({ runId: "1", startedAt: 1, endedAt: 2, status: "ok" }),
    JSON.stringify({ runId: "2", startedAt: "yesterday", endedAt: 2, status: "ok" }),
    JSON.stringify({ runId: "3", startedAt: 1, endedAt: 2, status: "probably fine" }),
    JSON.stringify({ runId: "4", startedAt: 3, endedAt: 4, status: "error" }),
    "",
  ].join("\n"));

  assert.deepEqual(readRuns("abc").map((entry) => entry.runId), ["1", "4"]);
});

test("a run log that cannot be read is an error, not an empty history", (t) => {
  const dir = withTempDir(t);
  mkdirSync(join(dir, "runs"), { recursive: true });
  const path = join(dir, "runs", "abc.jsonl");
  writeFileSync(path, `${JSON.stringify({ runId: "1", startedAt: 1, endedAt: 2, status: "ok" })}\n`);
  chmodSync(path, 0o000);
  if (process.getuid?.() === 0) return;

  // Returning [] here used to let compaction rewrite the log as empty.
  assert.throws(() => readRuns("abc"));
});

test("prune only counts logs it actually removed", (t) => {
  const dir = withTempDir(t);
  appendRun("gone1", { runId: "1", startedAt: 1, endedAt: 2, status: "ok" });
  appendRun("gone2", { runId: "1", startedAt: 1, endedAt: 2, status: "ok" });
  chmodSync(join(dir, "runs"), 0o500);
  if (process.getuid?.() === 0) return;

  try {
    // Reporting removals that did not happen is worse than reporting none, and
    // the caller needs the ids to tell the user what is still on disk.
    assert.deepEqual(pruneRuns([]), { removed: 0, failed: ["gone1", "gone2"] });
  } finally {
    chmodSync(join(dir, "runs"), 0o700);
  }
});

test("removing a task can take its history with it", (t) => {
  withTempDir(t);
  appendRun("abc", { runId: "1", startedAt: 1, endedAt: 2, status: "ok" });
  forgetRuns("abc");
  assert.deepEqual(readRuns("abc"), []);
  forgetRuns("abc");
});

test("prune drops history for tasks that no longer exist", (t) => {
  withTempDir(t);
  appendRun("alive123", { runId: "1", startedAt: 1, endedAt: 2, status: "ok" });
  appendRun("dead4567", { runId: "1", startedAt: 1, endedAt: 2, status: "ok" });

  assert.deepEqual(pruneRuns([task({ id: "alive123" })]), { removed: 1, failed: [] });
  assert.equal(readRuns("alive123").length, 1);
  assert.deepEqual(readRuns("dead4567"), []);
});

test("truncate leaves short values untouched", () => {
  assert.equal(truncate("short", 10), "short");
  assert.match(truncate("x".repeat(20), 10), /^x{10}\n… 10 more characters$/);
});

test("a task summarizes as one scannable line", () => {
  const now = Date.now();
  const line = formatTask(task({ name: "grades", model: "cerebras/gpt-oss-120b:low", lastStatus: "ok" }), now);
  assert.match(line, /aaaa1111 \(grades\)/);
  assert.match(line, /daily 15:30/);
  assert.match(line, /cerebras\/gpt-oss-120b:low/);
  assert.match(line, /last ok/);

  assert.match(formatTask(task({ paused: true }), now), /paused/);
  assert.match(formatTask(task({ runningSince: now - 5_000 }), now), /running for 5s/);
});

test("a history write failure still clears the claim and retires a one-shot", (t) => {
  const dir = withTempDir(t);
  // A regular file where runs/ should be, so every append fails with ENOTDIR.
  writeFileSync(join(dir, "runs"), "");
  writeRegistry({ version: 1, tasks: [claimTask(task({ kind: "once", id: "one11111" }), Date.now(), 1)] });

  // A task left "running" is invisible to every later tick until the stale
  // window, and a one-shot would never retire at all.
  assert.throws(() => settleRun("one11111", 100_000, Date.now(), { status: "ok", output: "done" }));
  assert.deepEqual(readRegistry().tasks, [], "the one-shot retired despite the unwritable log");
});

test("a history write failure on a recurring task still releases and advances it", (t) => {
  const dir = withTempDir(t);
  writeFileSync(join(dir, "runs"), "");
  writeRegistry({ version: 1, tasks: [claimTask(task(), Date.now(), 1)] });

  assert.throws(() => settleRun("aaaa1111", 100_000, Date.now(), { status: "error", error: "x" }));

  const [stored] = readRegistry().tasks;
  assert.equal(stored.runningSince, undefined, "the claim is gone even though the record is not");
  assert.equal(stored.lastStatus, "error");
  assert.ok(stored.nextRunAt > Date.now());
});

test("a malformed task is quarantined, not scheduled and not destroyed", (t) => {
  const dir = withTempDir(t);
  const junk = { id: "junk", kind: "weekly", prompt: "x", createdAt: 0, nextRunAt: 0 };
  writeFileSync(join(dir, "tasks.json"), JSON.stringify({
    version: 1,
    tasks: [task(), junk],
  }));

  const warnings = [];
  const listener = (warning) => warnings.push(warning.message);
  process.on("warning", listener);
  t.after(() => process.removeListener("warning", listener));

  const registry = readRegistry();
  assert.equal(registry.tasks.length, 1, "the bad entry is not schedulable");
  assert.deepEqual(registry.quarantined, [junk]);

  // The whole point: an unrelated write must not be what deletes it.
  writeRegistry({ ...registry, tasks: [...registry.tasks, task({ id: "cccc3333" })] });
  const onDisk = JSON.parse(readFileSync(join(dir, "tasks.json"), "utf8"));
  assert.equal(onDisk.tasks.length, 3);
  assert.deepEqual(onDisk.tasks.at(-1), junk, "still there, verbatim, after a write");

  return new Promise((resolve) => setImmediate(() => {
    assert.ok(warnings.some((message) => /Ignoring 1 malformed task/.test(message)), warnings.join("\n"));
    resolve();
  }));
});

test("a claim records the machine that made it", () => {
  const claimed = claimTask(task(), 1_000, 4242);
  assert.equal(claimed.runnerHost, hostname());
  // Releasing clears all three, or the next claim inherits a stale host.
  const released = releaseTask(claimed, 2_000, "ok");
  assert.equal(released.runnerHost, undefined);
  assert.equal(released.runnerPid, undefined);
  assert.equal(released.runningSince, undefined);
});

test("a claim from another machine is never declared dead by pid", async () => {
  // The failure this prevents: two machines on one synced registry. B probes
  // A's pid, gets ESRCH for a runner that is fine, and runs the prompt again.
  // The pid is a dead one on purpose: if the host guard were dropped, the probe
  // would report it stale and this test would fail rather than pass by luck.
  const foreign = {
    ...task(),
    runningSince: Date.now() - 1_000,
    runnerPid: await deadPid(),
    runnerHost: `not-${hostname()}`,
  };
  assert.equal(isClaimStale(foreign, Date.now()), false, "a foreign pid says nothing");

  // The age rule still applies, so a genuinely wedged foreign runner is not
  // permanent — it just takes timeout + 6h, as it did before pid probing.
  assert.equal(isClaimStale({ ...foreign, runningSince: Date.now() - (7 * 3_600_000) }, Date.now()), true);
});

test("a claim with no host is still probed, so upgrades keep working", async () => {
  // Written by a version before runnerHost existed. Treating undefined as
  // "foreign" would silently disable pid staleness for every existing claim.
  const legacy = { ...task(), runningSince: Date.now() - 1_000, runnerPid: await deadPid() };
  assert.equal(isClaimStale(legacy, Date.now()), true, "a dead runner leaves a stale claim");
});

test("a claim carrying an unknown host is valid, not quarantined", () => {
  // An older version reading a newer registry must not treat the extra field
  // as corruption and park the task.
  assert.equal(isDurableTask({ ...task(), runningSince: 1, runnerPid: 2, runnerHost: "other" }), true);
  assert.equal(isDurableTask({ ...task(), runningSince: 1, runnerPid: 2, runnerHost: 7 }), false);
});
