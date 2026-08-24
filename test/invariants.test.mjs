/**
 * Source-level invariants, checked mechanically.
 *
 * Not behaviour tests. These exist because four review passes each found one
 * instance of the same bug — a fix applied to `bin/pi-scheduler` but not
 * `extensions/durable-scheduler.ts`, or the reverse — and every instance
 * passed the entire suite. The class is invisible to behaviour tests by
 * construction: both paths work, they just disagree.
 *
 * A grep is an ugly test. It is also the only kind that catches this.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), "utf8");

/** Files that drive the registry but do not own it. */
const CONSUMERS = [
  "bin/pi-scheduler",
  "extensions/durable-scheduler.ts",
  "extensions/session-scheduler.ts",
];

function offendingLines(source, pattern) {
  return source
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => pattern.test(line) && !line.startsWith("//") && !line.startsWith("*"));
}

test("only task-registry.ts writes the fields that make up a claim", () => {
  // `claimTask` and `releaseTask` own `runningSince`/`runnerPid`/`runnerHost`
  // as a set. A consumer that hand-rolls two of the three writes a claim that
  // looks valid and behaves wrongly — which is exactly how `/schedule run`
  // ended up unable to recover a dead runner while the CLI could.
  const assignment = /\b(?:runningSince|runnerPid|runnerHost)\s*[:=](?!=)/;
  for (const path of CONSUMERS) {
    const offenders = offendingLines(read(path), assignment);
    assert.deepEqual(
      offenders,
      [],
      `${path} assigns claim fields directly; use claimTask/releaseTask instead`,
    );
  }
});

test("only task-registry.ts decides whether a claim is stale", () => {
  // Duplicating the rule is how the two halves drift: the age threshold moved
  // once already, and pid liveness was added to one call site before the other.
  const handRolled = /Date\.now\(\)\s*-\s*\w*\.?runningSince|CLAIM_STALE_MS/;
  for (const path of CONSUMERS) {
    const offenders = offendingLines(read(path), handRolled);
    assert.deepEqual(offenders, [], `${path} reimplements staleness; call isClaimStale`);
  }
});

test("every durable subcommand the CLI has is either in the extension or knowingly absent", () => {
  // The divergences were all in commands both surfaces implement. This does
  // not demand parity — it demands that a new CLI command is a deliberate
  // decision about the extension rather than an oversight.
  const cli = read("bin/pi-scheduler");
  const extension = read("extensions/durable-scheduler.ts");

  const commands = [...cli.matchAll(/^\s*case "([a-z]+)":/gm)].map((match) => match[1]);
  assert.ok(commands.length > 5, "the command switch should have been found");

  // Deliberately shell-only: they manage the machine, not the tasks. `add` is
  // *not* on this list — creation exists in both surfaces, and it is the most
  // likely thing to drift, since the two applyFlags already differ in shape.
  const shellOnly = new Set(["check", "install", "uninstall", "prune", "edit", "help"]);
  const shapes = extension.slice(extension.indexOf("const SUBCOMMAND_SHAPES"));

  for (const command of commands) {
    if (shellOnly.has(command)) continue;
    // Creation is not a verb in the extension: `/schedule <spec>` falls through
    // to the bare-spec branch, so match that instead of the usage map.
    if (command === "add") {
      assert.match(
        extension,
        /parseScheduleSpec\(/,
        "the extension no longer creates tasks; add is not shell-only",
      );
      continue;
    }
    assert.ok(
      shapes.includes(`  ${command}:`),
      `${command} exists in the CLI but not in /schedule, and is not on the shell-only list`,
    );
  }
});

test("creation applies the same flags on both surfaces", () => {
  // The pair most likely to drift, and the one the subcommand check cannot see:
  // both applyFlags are hand-written against different parser output, so a flag
  // added to one is silently ignored by the other rather than rejected.
  const bodyOf = (source) => {
    const start = source.indexOf("function applyFlags");
    assert.notEqual(start, -1, "applyFlags should exist in both surfaces");
    return source.slice(start, source.indexOf("\n}", start));
  };
  const cli = bodyOf(read("bin/pi-scheduler"));
  const extension = bodyOf(read("extensions/durable-scheduler.ts"));

  // The extension spells --no-tools/--no-deliver as their own keys; the CLI
  // folds them into false/null on the positive key. Normalise, then compare.
  const handled = (body) =>
    new Set(
      [...body.matchAll(/flags(?:\.(\w+)|\["([\w-]+)"\])/g)]
        .map((match) => (match[1] ?? match[2]).replace(/^no-/, ""))
        .sort(),
    );

  assert.deepEqual(
    [...handled(cli)].sort(),
    [...handled(extension)].sort(),
    "one surface handles a creation flag the other ignores",
  );
});
