# The agent worker

The studio's Agents page runs the team's Claude Code skills — folders with a
`SKILL.md`, Python scripts, references and `agents/*.md` subagents — on a
machine of ours, not on Vercel. That machine runs **the worker**: a Node
process in this repo (`worker/`) that claims queued runs from the database,
drives Claude Code through the [Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/overview),
writes what happens back as events, and uploads what the skill produced to
the media store. The web app only reads and writes rows; the two never talk
directly, so the app stays on Vercel with plain polling.

```
pnpm agent-worker          # from the repo root; loads .env.local when present
```

## What it needs on the box

- Node 22 and `corepack` (pnpm). The repo checked out, `pnpm install` done.
- Python 3 with what the owner's skills import:
  `pip install httpx higgsfield-client openai-whisper pillow numpy`
  (Whisper pulls torch; the CPU wheel is enough and far smaller:
  `pip install torch --index-url https://download.pytorch.org/whl/cpu` first).
- `ffmpeg` on the PATH.
- Network access to Anthropic, KIE and the media store.

`Dockerfile.worker` builds all of that into one image (node:22 + python3 +
ffmpeg + those pips) for a container host.

## Environment

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | The same Postgres the web app uses. Required for the standalone worker: the embedded PGlite is single-process and belongs to the app (see *Running locally*). Without it the worker refuses to start; `AGENT_ALLOW_PGLITE=1` overrides that only when the app is not running. |
| `ANTHROPIC_API_KEY` | What the Agent SDK bills. Without it the `claude` runtime fails every run with a clear `error` event instead of hanging. Bedrock / Vertex switches (`CLAUDE_CODE_USE_BEDROCK=1` …) work in its place. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | The media store, same values as the app. On a laptop checkout they may be empty: the worker then reads and writes `.data/media` directly, which works only when it runs from the same checkout as the app. |
| `KIE_API_KEY` | The deployment's fallback KIE key, same as the app. A team's own key (set in the team dialog) wins. |
| `APP_SECRET_KEY` | Unseals the teams' KIE keys at rest; must equal the app's. |
| `AGENT_HOME_ROOT` | Where each team's HOME lives: `<root>/<teamId>/`. Default `~/.openhiggsfield/agent-homes`. **It must be outside the checkout**: the agent's shell reads whatever its parent folders hold, and a checkout holds `.env.local`. The worker refuses to start when the root is inside its working directory and a `.env*` file sits there. Put it on a disk with room for takes and renders. |
| `AGENT_RUNTIME` | `claude` (default) or `fake`. The fake runtime replays a scripted run — text, a file, a question, an approval for a paid command, a PNG and a board, a result — with no model and no key, for tests and UI work. |
| `AGENT_WORKER_CONCURRENCY` | Runs one worker holds at once. Default 2. A run waiting on a person still holds its slot. |
| `AGENT_MODEL`, `AGENT_FALLBACK_MODEL` | Model for the agent loop; empty means Claude Code's default. |
| `AGENT_MAX_TURNS` | Model round-trips per turn before the run pauses for a reply (default 400). |
| `AGENT_CLAUDE_PATH` | A Claude Code binary to run when the SDK's optional platform package did not install (`pathToClaudeCodeExecutable`). |
| `AGENT_POLL_MS` | How often the loop looks for queued runs (default 3000). |
| `AGENT_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error`. Default `info`. |
| `HF_KEY`, `ELEVENLABS_API_KEY` | Keys the owner's skills read beside KIE's. They are not team settings yet; when set on the worker they go into every run's `.env`. |

The agent's subprocess sees an allowlist of the worker's environment, not
the rest of it: `PATH`, the locale, proxies and certificates, `ANTHROPIC_*`,
`CLAUDE_CODE_*`, `PYTHON*`/`VIRTUAL_ENV`, the cloud credentials a
`CLAUDE_CODE_USE_*` switch needs while it is on, plus `HOME` and the run's
keys (`worker/env.ts`). A `GITHUB_TOKEN`, an `SSH_AUTH_SOCK` or any other
variable the box or the unit file carries stays with the worker; a key a
skill's script needs from the box has to be named in `workerScriptKeys`.

The worker never prints a key. Every string that becomes an event or a log
line passes through a masker that knows the run's keys and the shapes of
tokens (`sk-…`, `hf_…`, `Bearer …`, `KEY=value` lines).

## What a run looks like on disk

```
$AGENT_HOME_ROOT/<teamId>/            the team's HOME for Claude Code
  .claude/skills/<slug>/               the skill, unpacked from the team's zip
  .claude/agents/*.md                  the skill's subagents, copied so they load
  .claude/projects/…                   Claude Code's session transcripts (resume)
  Documents/
  runs/<runId>/                        the run's working directory (cwd)
    inputs/                            what the person attached, original names
      .manifest.json                   file name → the url it came from
    outputs/                           where deliverables go; kept as artifacts
    .env                               KIE_API_KEY (+ HF_KEY, ELEVENLABS_API_KEY), mode 0600
```

One HOME per team keeps a team's skills, transcripts and files apart from
another team's; it is not an isolation boundary. Every HOME is made by the
same unix user, so a shell in one can `cat` another — isolation between teams
is the deployment's job (a unix user or a container per team), not the
worker's. The run's first prompt is `/<slug> <brief>`; every later message
from a person resumes the same session by id. A reply that attaches a file
under a name already in `inputs/` gets a numbered name (`ref-2.png`) unless
it is the same file again, as the manifest remembers. After each turn, new or
changed files under `outputs/` (and images, videos and Markdown anywhere
shallow in the workspace, up to 500 MB each) are uploaded under
`t/<team>/agents/<runId>/<path>` and recorded; unchanged files are skipped by
size and mtime, then by hash. Symlinks are never followed, by the scan or by
`publish`.

## Gates

Permissions stay in Claude Code's `default` mode and every ask lands in the
worker's `canUseTool`:

- `AskUserQuestion` becomes a `question` event; the run shows **waiting**
  until someone answers in the studio, and the answer goes back to the agent.
- A Bash command that matches the paid rules (`worker/gates.ts`:
  `--confirm-paid`, `engine/{batch,make_take,make_images,cast_soul}.py`,
  `kie.py watch|submit`, a `createTask` call against api.kie.ai,
  `higgsfield_client`) becomes an `approval` event. Approved, it runs;
  declined, the agent is told "Declined in the studio".
- A file tool (`Write`, `Edit`, `MultiEdit`, `NotebookEdit`) aimed under
  either `.claude/` — the HOME's, where settings, hooks, agents and the
  installed skills live, or the workspace's — is refused.
- Everything else — reads, other writes, other commands, the studio tools —
  runs.

The worker never runs with `bypassPermissions`. Bash is not in
`allowedTools`, and every query carries a policy tier (`managedSettings`)
that user and project settings files cannot widen: Bash is pinned to `ask`,
the file tools are denied under both `.claude/`, and hooks come from managed
settings alone (there are none). A `settings.json` the agent writes into its
own HOME therefore changes nothing.

The paid gate is a check on the command's shape, not a sandbox: a paid call
inside a script the agent wrote itself passes if its text matches no rule. The
fence that closes that — a loopback proxy that holds KIE's `createTask` for
approval and keeps the key out of the shell — is not built yet; until it is,
the KIE key is in the agent's environment and the approval card is the only
thing between the agent and a spend.

The agent also gets three tools of its own (`mcp__studio__*`): `publish`
puts a finished image or video on the team wall, `note` leaves a line in the
stream, `report_credits` adds KIE credits to the run's spend.

## Running locally

A laptop checkout has one process and one embedded database: PGlite admits a
single process, so `pnpm agent-worker` cannot run beside `pnpm dev`. Two ways
round it:

- **Inside the dev server.** Set `AGENT_DEV_WORKER=1` in `.env.local` and
  restart `pnpm dev`: the dev server hosts the worker's loop itself
  (`src/server/agent-dev-worker.ts`, started from `src/instrumentation.ts`;
  the same pass as `worker/main.ts`, in `worker/loop.ts`), so a run started
  on `/agents` is picked up in the same process. With `AGENT_RUNTIME=fake` a
  scripted run plays through the run view with no model and no key; with the
  default `claude` runtime and an `ANTHROPIC_API_KEY`, the real agent runs,
  with HOMEs under `~/.openhiggsfield/agent-homes/` (never under the
  checkout; see `AGENT_HOME_ROOT`). Never in production: the flag is ignored
  there.
- **Two processes on Postgres.** Point both `pnpm dev` and `pnpm agent-worker`
  at a local or Neon Postgres through `DATABASE_URL` (`DB_AUTO_MIGRATE=1` once
  for the app). The local media store serves both when they run from the same
  checkout: the worker reads `.data/media` directly.

## Lifecycle and recovery

The worker claims one queued run at a time (`FOR UPDATE SKIP LOCKED`), holds a
two-minute lease and renews it while the run is open. A worker that dies
stops renewing; `reclaimStale()` puts the run back in the queue with a
"worker lost" status (lease and clock both the database's), and the next
worker resumes the session: it waits for a message — or for the team's answer
to a question or approval card the dead session left open, which it hands
the agent as words, since the tool call behind the card is gone (an approved
command did not run and is asked for again). Every write a worker makes
names itself and lands only while the run is leased to it; a worker whose run
was reclaimed learns so at its next event, inbox poll or finish and drops the
run without another word. `SIGTERM` interrupts the active sessions, marks
their runs **queued** with "worker stopping" and exits within twenty seconds.

A turn that ends with the agent asking leaves the run **waiting** (reply in
the studio); a turn that ends stating closes it as **done**. Stop ends it as
**stopped**; an execution error as **failed** with the reason on the run.

## systemd

```ini
[Unit]
Description=Studio agent worker
After=network-online.target

[Service]
User=agent
WorkingDirectory=/srv/open-higgsfield
EnvironmentFile=/srv/open-higgsfield/.env.worker
ExecStart=/usr/bin/corepack pnpm agent-worker
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

## Security

Skills are code. They run as the worker's user, with the team's KIE key in
their environment and whatever the box can reach on the network. That is why:

- only team admins can upload a skill, and a bundle is checked (size, file
  count, paths, symlinks) before it is stored;
- every team gets its own HOME, and the agent's environment is an allowlist:
  the worker's own secrets (the database url, the bucket credentials, the
  app's sealing key) and everything else on the box stay with the worker;
- the agent cannot rewrite its own permissions: the policy tier pins Bash to
  `ask` and the `.claude/` folders read-only for the file tools, whatever a
  settings file says;
- keys reach a skill only through the run's `.env` and the process
  environment, never through an event, a prompt or a log;
- money moves only after a person approves the command in the studio — by
  the command's shape, see *Gates* for what that does and does not cover.

Hard requirements, not tips:

- `AGENT_HOME_ROOT` is outside the checkout (the worker refuses to start
  otherwise when a `.env*` file is next to it), and the worker runs as a
  dedicated unix user with no read access to the checkout or its `.env`
  files — a `cd ..` in the agent's shell must find nothing.
- The box holds nothing else of value, and `AGENT_HOME_ROOT` has its own disk
  quota.
- Teams that must not read each other's HOMEs (a shell in one can `cat` the
  others') run under a unix user or a container per team.
