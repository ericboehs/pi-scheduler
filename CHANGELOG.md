# Changelog

Notable changes to pi-scheduler. While the major version is 0, a minor bump may
change behaviour; each one says what it breaks.

## [0.2.0] — 2026-08-24

A correctness pass over the durable scheduler, from a multi-pass review of the
whole repository. There are no new features. Every entry is a case where the
scheduler could run a task twice, lose something, or report success for
something that did not happen.

### Upgrading

Re-run `pi-scheduler install`. The generated launchd plist and systemd units
changed, and an existing install keeps running the old ones until it is
replaced.

Two things are stricter and may break a script:

- Unknown or misplaced flags are errors instead of being ignored.
- `resume` on a one-shot whose time has passed leaves it paused and exits 1.
  Give it a new time with `edit --schedule`.

### Fixed — running a task twice

- `pi-scheduler run` did not claim the task. A manual run and the minute tick
  could both spawn pi for the same prompt, double-advance the schedule, and pay
  for the model twice.
- A claim left by a runner that was SIGKILLed blocked its task for the full
  six-hour stale window. A claim is now also stale once its runner's pid is
  gone.
- That pid probe is per-host. A claim records `runnerHost` and a foreign one is
  never probed, so two machines sharing a registry do not each read the other's
  live runner as dead — which would have been worse than the age rule it
  replaced.
- A run that overran the stale window and was reclaimed by another runner could
  report its result over the new claim and release it, returning a task to the
  pool while it was still running. `settleRun` now settles only as the claim it
  was handed.

### Fixed — losing data

- A corrupt or unreadable registry read as empty, and the next `add` wrote that
  emptiness over the file. Every task, gone. It is now an error.
- A single malformed task entry was silently dropped by the next write. Entries
  that fail validation are quarantined instead: kept verbatim, written back,
  never scheduled or matched.
- `forgetRuns` swallowed every failure, so `remove` reported success with the
  prompts and outputs still on disk.
- A `/once` was removed from the list before delivery was attempted, so one
  that failed to deliver vanished without a record.
- A failed history write inside `settleRun` took the claim release with it.

### Fixed — reporting success for something that did not happen

- `install` and `uninstall` ignored every `launchctl` and `systemctl` exit
  code. "Installed" over a scheduler that was not running; "Removed" over one
  still firing every minute.
- `uninstall` deleted the unit files even when the job could not be stopped,
  taking with them the configuration needed to retry or diagnose.
- `runs` reported "no runs recorded" over a log it could not open.
- A delivery whose output exceeded 128KiB failed the entire spawn with `E2BIG`
  on Linux — one env var over `MAX_ARG_STRLEN` — so the task ran and delivered
  nothing. Only the environment copy is capped now; stdin still carries it all.
- EPIPE writing a prompt to pi was swallowed along with the harmless kind, so a
  pi that never received its prompt could report a confident answer to a
  question that was never fully asked. The two cases are now distinguished.

### Fixed — crashing, hanging, or stranding the tick

- A grandchild holding the stdio pipes meant `close` never fired and a run hung
  to its timeout. Children are spawned detached and signalled as a group.
- A history line carrying a non-string `error` took down the whole `runs`
  command through `record.error.split`.
- One task failing to settle stranded every other due task in the same tick.
- `die()` called `process.exit` from inside the registry lock, skipping the
  release, so one bad argument blocked every other invocation — including the
  tick — for 60 seconds.
- Kill-escalation timers survived a child that exited promptly, so `SIGKILL`
  could later be sent to a pid the OS had reassigned.

### Fixed — doing nothing, quietly

- A typo'd or misplaced flag was accepted and ignored (`list --model x`,
  `--nmae nightly`). Flags are now checked against the command invoked.
- Short flags were positional, so `run -x` took `-x` as the task selector and
  `check -x` succeeded silently.
- `runs <id>` failed for a one-shot that had already retired, which is exactly
  the case people ask about: the reminder that should have fired last night.
- Resuming a durable one-shot whose moment had passed fired it immediately —
  the one thing pausing was meant to prevent.
- A session snapshot that was corrupt, or had no session id, fell through to an
  older one and re-armed timers the user had cancelled.
- The installed service read the default registry even when installed from a
  different `PI_SCHEDULER_DIR`, which looks exactly like a scheduler that
  silently does nothing. The units now carry `PI_SCHEDULER_DIR` and
  `PI_AGENT_DIR`.
- `nameTaken` was case-sensitive while lookup was not, so `add --name Nightly`
  alongside `nightly` created a task that could never be selected.

### Changed

- `Persistent=true` is gone from the systemd timer. It applies only to
  `OnCalendar=`, and this unit uses `OnBootSec=`/`OnUnitActiveSec=`; catching up
  after sleep is the misfire policy's job on both platforms.
- Environment values in the systemd unit are quoted as systemd.exec(5)
  documents, and the plist is XML-escaped, so a path containing a space or `&`
  survives installation.
- A task whose recorded cwd was deleted falls back to `$HOME`; one that exists
  but cannot be used is an error rather than a fallback. This was only ever in
  a source comment and is now in the README.
- Two benchmark figures in the README had no measurement behind them and have
  been removed rather than restated more precisely.

### Added

- `test/cli.test.mjs` — `bin/pi-scheduler` exercised end to end as a real
  subprocess against a fake `pi` that records its invocations, so exactly-once
  behaviour is asserted rather than reasoned about.
- `test/invariants.test.mjs` — source-level checks for the one bug class that
  behaviour tests cannot see: a fix applied to the CLI but not the extension,
  or the reverse. Both paths work; they just disagree.
- `test/runner.test.mjs` — the subprocess layer on its own.
- 113 tests to 176.

## [0.1.0] — 2026-08-24

First release.

- `/once` and `/loop` — timers that fire a prompt into the current
  conversation.
- `/schedule` — durable tasks that run in their own `pi -p` whether or not pi
  is open, with per-task model, cwd, delivery command and misfire policy.
- `pi-scheduler install` — a per-minute launchd job or systemd `--user` timer.

Neither extension registers an LLM tool or adds anything to model context.

[0.2.0]: https://github.com/ericboehs/pi-scheduler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ericboehs/pi-scheduler/releases/tag/v0.1.0
