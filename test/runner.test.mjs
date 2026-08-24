/**
 * What `runTask` actually does to a child process.
 *
 * The fake pi here is a shell script that dumps its argv, cwd, environment and
 * stdin, so the assertions are about observed behaviour rather than about the
 * shape of the arguments we happened to build.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const { runTask } = await import("../extensions/lib/runner.ts");

function withTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-sched-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write an executable shell script and return its path. */
function script(dir, name, body) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function task(dir, overrides = {}) {
  return {
    id: "run00001",
    name: "reporter",
    kind: "daily",
    dailyAt: "09:00",
    prompt: "summarize the day",
    cwd: dir,
    createdAt: Date.now(),
    nextRunAt: Date.now(),
    ...overrides,
  };
}

test("a successful run captures stdout and reports ok", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", 'cat > /dev/null; echo "  all quiet  "');

  const outcome = await runTask(task(dir), { piBin });
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.output, "all quiet", "trimmed, because a trailing newline is not content");
});

test("the prompt arrives on stdin, never in argv where ps would show it", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(
    dir,
    "pi",
    `cat > ${JSON.stringify(join(dir, "stdin"))}; echo "$@" > ${JSON.stringify(join(dir, "argv"))}`,
  );

  await runTask(task(dir, { prompt: "an embarrassingly private prompt" }), { piBin });

  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "an embarrassingly private prompt");
  const argv = readFileSync(join(dir, "argv"), "utf8");
  assert.doesNotMatch(argv, /embarrassingly/, "the prompt must not be visible in ps");
  assert.match(argv, /-p/);
  assert.match(argv, /--no-session/);
  assert.match(argv, /--no-themes/);
});

test("the model and the feature flags reach the child", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", `cat > /dev/null; echo "$@" > ${JSON.stringify(join(dir, "argv"))}`);

  await runTask(task(dir, { model: "cerebras/gpt-oss-120b:low", without: ["tools", "skills"] }), { piBin });

  const argv = readFileSync(join(dir, "argv"), "utf8");
  assert.match(argv, /--model cerebras\/gpt-oss-120b:low/);
  assert.match(argv, /--no-tools/);
  assert.match(argv, /--no-skills/);
  assert.doesNotMatch(argv, /--no-extensions/, "only what was switched off");
});

test("the run happens in the directory the task recorded", async (t) => {
  const dir = withTempDir(t);
  const project = join(dir, "project");
  mkdirSync(project);
  const piBin = script(dir, "pi", "cat > /dev/null; pwd");

  const outcome = await runTask(task(dir, { cwd: project }), { piBin });
  // macOS reports /private/var for /var, so only the tail is portable.
  assert.match(outcome.output, /project$/);
});

test("a cwd that has been deleted falls back to $HOME rather than failing", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", "cat > /dev/null; pwd");

  const outcome = await runTask(task(dir, { cwd: join(dir, "long-gone") }), { piBin });
  assert.equal(outcome.status, "ok", "a moved project should not silently stop the task");
  // Asserting "ok" alone would pass for any valid directory, including the
  // one this test happens to run from. realpath because macOS reports $TMPDIR
  // and $HOME through /private.
  assert.equal(realpathSync(outcome.output), realpathSync(homedir()));
});

test("a cwd that exists but is not a directory is an error, not a silent $HOME run", async (t) => {
  const dir = withTempDir(t);
  const notADir = join(dir, "file");
  writeFileSync(notADir, "");
  const piBin = script(dir, "pi", "cat > /dev/null; echo ran");

  // Running a tool-enabled prompt against the wrong project and calling it a
  // success is worse than not running it at all.
  const outcome = await runTask(task(dir, { cwd: notADir }), { piBin });
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /not a directory/);
});

test("a nonzero exit is an error carrying stderr, not a successful empty report", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", 'cat > /dev/null; echo "no credentials" >&2; exit 7');

  const outcome = await runTask(task(dir), { piBin });
  assert.equal(outcome.status, "error");
  assert.equal(outcome.exitCode, 7);
  assert.match(outcome.error, /no credentials/);
});

test("a run that overruns its timeout is killed and reported as a timeout", async (t) => {
  const dir = withTempDir(t);
  // The sleep is a grandchild: signalling only the shell would leave it
  // holding the stdio pipes, and 'close' would not fire for another 30s.
  const piBin = script(dir, "pi", "cat > /dev/null; sleep 30");

  const startedAt = Date.now();
  const outcome = await runTask(task(dir, { timeoutMs: 300 }), { piBin });
  assert.equal(outcome.status, "timeout");
  assert.match(outcome.error, /no result within 300ms/);
  assert.ok(Date.now() - startedAt < 5_000, "the whole process tree goes, not just the shell");
});

test("deliver gets the output on stdin and in $PI_SCHEDULER_OUTPUT", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", 'cat > /dev/null; echo "the report"');
  const stdinFile = join(dir, "delivered-stdin");
  const envFile = join(dir, "delivered-env");

  const outcome = await runTask(
    task(dir, {
      deliver: `cat > ${JSON.stringify(stdinFile)}; printf '%s|%s' "$PI_SCHEDULER_OUTPUT" "$PI_SCHEDULER_TASK" > ${JSON.stringify(envFile)}`,
    }),
    { piBin },
  );

  assert.equal(outcome.status, "ok");
  assert.equal(readFileSync(stdinFile, "utf8"), "the report");
  assert.equal(readFileSync(envFile, "utf8"), "the report|reporter");
});

test("a deliver command that ignores stdin is fine; plenty of one-liners do", async (t) => {
  const dir = withTempDir(t);
  // Far more than a pipe buffer, so `true` exiting without reading really does
  // break the pipe. A short report would fit in the buffer and the write would
  // succeed, which would let this pass even if delivery EPIPE became fatal.
  const piBin = script(dir, "pi", `cat > /dev/null; yes "the report" | head -c 400000`);

  const outcome = await runTask(task(dir, { deliver: "true" }), { piBin });
  assert.equal(outcome.status, "ok", "EPIPE on a delivery pipe is expected, not a failure");
});

test("output past the cap is marked, so a partial report is never mistaken for the whole one", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", 'cat > /dev/null; yes "filler" | head -c 300000');

  const outcome = await runTask(task(dir), { piBin });
  assert.equal(outcome.status, "ok");
  assert.match(outcome.output, /output truncated at 200000 characters$/);
});

test("a failing deliver fails the run, since the output went nowhere", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", 'cat > /dev/null; echo "the report"');

  const outcome = await runTask(task(dir, { deliver: 'echo "slack is down" >&2; exit 1' }), { piBin });
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /slack is down/);
  assert.equal(outcome.output, "the report", "the result is still worth keeping in the log");
});

test("a deliver that hangs is reported as a delivery timeout, not a mystery signal", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", 'cat > /dev/null; echo "the report"');

  // 120s is too long for a test, so this only checks the message shape that a
  // real hang would produce: the SIGTERM must be explained, not just reported.
  const outcome = await runTask(task(dir, { deliver: "sleep 30" }), { piBin, deliveryTimeoutMs: 300 });
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /did not finish within 300ms/);
});

test("empty output skips delivery instead of paging about a quiet day", async (t) => {
  const dir = withTempDir(t);
  const piBin = script(dir, "pi", "cat > /dev/null; true");
  const marker = join(dir, "delivered");

  const outcome = await runTask(task(dir, { deliver: `touch ${JSON.stringify(marker)}` }), { piBin });
  assert.equal(outcome.status, "ok");
  assert.throws(() => readFileSync(marker), "nothing to deliver, so nothing was delivered");
});

test("a pi that never reads its prompt is an error, not a confident wrong answer", async (t) => {
  const dir = withTempDir(t);
  // Exits without draining stdin. A prompt larger than the pipe buffer makes
  // the broken pipe deterministic rather than occasional.
  const piBin = script(dir, "pi", 'echo "I have opinions"; exit 0');

  const outcome = await runTask(task(dir, { prompt: "x".repeat(1_000_000) }), { piBin });
  assert.equal(outcome.status, "error", "the question was never fully asked");
  assert.match(outcome.error, /could not send the prompt/);
});

test("a pi that cannot be started says so instead of throwing", async (t) => {
  const dir = withTempDir(t);
  const outcome = await runTask(task(dir), { piBin: join(dir, "not-installed") });
  assert.equal(outcome.status, "error");
  assert.match(outcome.error, /could not start/);
});
