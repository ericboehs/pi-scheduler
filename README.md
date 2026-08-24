# pi-scheduler

Scheduled prompts for [pi](https://pi.dev). Two schedulers, split by *what the
task needs to survive* — the one distinction that actually changes the
implementation.

| | `/once`, `/loop` | `/schedule` |
|---|---|---|
| Runs in | this conversation | a fresh isolated `pi -p` |
| Needs pi open | yes | no |
| Survives quitting pi | no | yes |
| Model | whatever the session is using | per task |
| Stored in | a custom session entry | `~/.pi/agent/scheduler/tasks.json` |
| Missed fires | dropped | caught up once, within a grace window |

**Neither extension registers an LLM tool or adds anything to model context.**
Nothing stays resident, and interactive pi startup is untouched.

## Install

```sh
pi install git:github.com/ericboehs/pi-scheduler
```

For durable tasks you also want the CLI on your `PATH`. The package is cloned
to `~/.pi/agent/git/github.com/ericboehs/pi-scheduler`:

```sh
ln -s ~/.pi/agent/git/github.com/ericboehs/pi-scheduler/bin/pi-scheduler ~/bin/pi-scheduler
pi-scheduler install    # per-minute launchd job, or systemd --user timer
```

Requires Node >= 22.18 (the CLI imports the extensions' `.ts` modules directly
under Node's type stripping).

## Session timers: `/once` and `/loop`

`extensions/session-scheduler.ts`. In-process timers that fire a prompt into
the current conversation.

```text
/once 15m check whether the deploy finished
/once at 8p check in on this
/once remind me about the PR in 2h
/once list | cancel <id>
/loop 15m check CI
/loop review the deploy every 1h
/loop list | cancel <id> | clear
/loop pause <id|all> | resume <id|all>
```

`/once` is the one-shot counterpart to `/loop`. The time may lead (`/once 15m
check the build`, with an optional `in`/`at`) or trail (`/once check the build
in 15m`); the leading form wins when its first token parses as a time, so
`/once 8p check in on this` keeps the prompt's own "in" intact.

`pause` disarms a timer but keeps it listed, so it survives session resume
without firing or drifting. `resume` recomputes the next occurrence rather than
replaying what was missed: a recurring task advances to its next future slot,
and a one-shot whose time passed while paused is dropped with a warning instead
of firing late.

## Durable tasks: `/schedule`

`extensions/durable-scheduler.ts` plus `bin/pi-scheduler`. These run whether or
not pi is open, which is the point: a weekday grade check at 15:30 cannot
depend on a terminal being left running.

```text
/schedule --name grades --model openai/gpt-5-mini daily 15:30 :: check the kids' grades
/schedule cron 30 15 * * 1-5 :: weekday grade check
/schedule --misfire always once 8p :: check in on the deploy
/schedule list [all] | show <id> | runs <id>
/schedule run <id> | pause <id|all> | resume <id|all> | remove <id>
```

`/schedule run` fires a task now, exactly as the timer would: **its own pi, its
own cwd and model, not this conversation and not this conversation's context.**
It does not block the session — a task's timeout defaults to 15 minutes, and
waiting that long to watch an unattended job is the wrong trade — so the footer
shows what is in flight and the output arrives as a notice when it lands.
`runs` (plural) is the read-only history.

Options go **first**, before the schedule: `--name --model --cwd
--with/--without --deliver --misfire --timeout`. Flags are only recognized
while they lead, because the schedule itself is variable length (a cron
expression is five bare words) and there is otherwise no reliable place to stop
scanning — so a prompt containing `--force` is never mistaken for an option.

The same tasks are managed from the shell:

```sh
pi-scheduler install          # per-minute launchd job, or systemd --user timer
pi-scheduler list
pi-scheduler add daily 15:30 :: check grades --name grades
pi-scheduler run grades       # ignore the schedule and run now
pi-scheduler runs grades      # recent history
pi-scheduler check            # what the timer calls
pi-scheduler uninstall
```

Quote a cron expression in the shell — `cron 30 15 * * 1-5` is otherwise
expanded into filenames before the scheduler ever sees it.

### Nothing stays resident

A launchd job (or systemd `--user` timer on Linux) runs `pi-scheduler check`
every 60s; it reads one JSON file and exits, measured at ~73ms when nothing is
due. pi is only spawned when a task is actually due.

The launchd label is `com.ericboehs.pi-scheduler`; the systemd unit is
`pi-scheduler.timer`. On Linux, `Persistent=true` means a laptop suspended over
the scheduled minute still gets its tick, and user timers stop when your last
session ends unless you `sudo loginctl enable-linger <user>`.

### What a scheduled run loads

Each run is a fresh `pi -p` that loads **what an interactive pi would**: your
extensions, skills, prompt templates, and the `AGENTS.md` of the directory the
task was created in. A task records its cwd at creation, so project context is
the context you had in mind when you wrote the prompt. That means the prompt
can simply be a slash command:

```sh
cd ~/Code/some/repo
pi-scheduler add --name checkin daily 9a :: /checkin
```

Full discovery costs about 0.3s more at startup than a stripped one, which is
nothing for something that runs once a day, and the alternative — a scheduled
run that behaves unlike the pi you tested the prompt in — is a worse trade.

`--without` strips pieces back out: `extensions`, `skills`, `templates`,
`context`, `tools`. `--without tools` makes a run answer-only, worth doing for
anything that just summarizes. `--with` is the inverse allowlist, and `--with
none` is a bare pi — fastest, and immune to a broken extension. Themes have no
switch and are always off: there is no TUI to theme, and `--no-session` is
always passed so an unattended daily job cannot grow a session file forever.

Runs are never messages into an existing session: pi appends to session JSONL
without file locking, so writing into a session that might be open in a
terminal risks interleaved entries. Each run is its own pi, which is also why a
task carries its own `--model` rather than inheriting whatever a human left
selected three days ago.

### Delivering the result

`--deliver` is a shell command that receives the output on stdin and in
`$PI_SCHEDULER_OUTPUT`. The prompt and the result both travel by stdin rather
than argv, so neither shows up in `ps`.

```sh
pi-scheduler add --name grades --model openai/gpt-5-mini \
  --deliver 'my-slack-webhook-script' \
  'cron 30 15 * * 1-5' :: 'Summarize these grades and flag anything below 80.'
```

A run is only recorded `ok` if the delivery command also exits 0, so a broken
webhook shows up in `pi-scheduler runs` instead of failing silently.

### Missed fires

`--misfire` decides what a late run does, because machines sleep: `skip` never
runs late, `always` always does, and a duration (default `2h`) is the window
within which a catch-up is still wanted. Late runs **coalesce** — one catch-up,
never a replay of every missed slot.

### Storage and concurrency

The registry is `~/.pi/agent/scheduler/` (override with `PI_SCHEDULER_DIR`),
mode 0700 with 0600 files, since prompts and run output are routinely private.
Read-modify-write goes through a `mkdir` mutex held only for the JSON round
trip; the agent run itself happens outside the lock, guarded instead by a claim
recorded on the task, so two overlapping ticks cannot double-run one job and a
runner that dies has its claim reclaimed rather than wedging the task forever.

## Cron syntax

Both schedulers take a standard 5-field crontab expression (minute, hour,
day-of-month, month, day-of-week) with ranges, lists, `*/n` steps, and
`jan`/`mon` style names, plus the `@hourly`, `@daily`, `@weekly`, `@monthly`
and `@yearly` macros. When both day-of-month and day-of-week are restricted
they are OR'd, matching Vixie cron. There is no seconds field — a 6-field
expression is rejected rather than reinterpreted, and an expression that can
never match (`0 0 30 2 *`) is refused at creation.

## Edge cases worth knowing

Session timers live in custom session entries, so they restore when you resume
that session and are not inherited by `/new`, `/fork` or `/clone`. Pi must be
running; missed fires are skipped rather than replayed after resume. Recurring
intervals have a one-minute minimum, in both schedulers.

From pi's `SessionManager._persist`: pi does not create the session file until
the session holds at least one assistant message. A timer set before that is
buffered in memory and written out with the first reply — but one set in a
session that never prompts the model is lost on exit. `/once` and `/loop` warn
when they detect this state, and the task is still created. `/schedule` is
immune, since it writes to its own registry.

## Development

```sh
npm test          # node --test test/
npx tsc --noEmit  # needs node_modules/@earendil-works/pi-coding-agent linked
```

`erasableSyntaxOnly` in `tsconfig.json` is load-bearing rather than style. pi
transpiles extensions, but `bin/pi-scheduler` imports the same `.ts` modules
under Node's strip-only mode, which rejects parameter properties, enums and
namespaces outright. Fix the construct, never relax the flag.

`extensions/lib/` is imported by all three front-ends — the extension, the CLI,
and the tick — deliberately, so they agree exactly on when a task is due. It is
excluded from the `pi.extensions` glob in `package.json` so pi does not try to
load those modules as extensions.

## License

MIT
