# OpenHiggsfield on KIE — the creative studio for a performance-marketing team

> A fork of [open-higgsfield](https://github.com/wide-trace/open-higgsfield)
> that generates through [KIE.ai](https://kie.ai) instead of the Higgsfield
> platform: one prompt bar, 35 image and video models, one team key.

This checkout is milestones 1 to 9 of a larger build: the studio runs on KIE
behind its original seams (catalog → plane → server action → poll); every
visitor is a member of a team that signs in with a magic link and shares one
KIE key; every run is a row before KIE is asked and every result is copied
into the team's own store; the wall is the team's, scoped by product and
project, searchable and filterable on the server; the direct-response
loop — formats, compare, upscale, export — runs on top of it; the
workspace lives in a sidebar while the inputs arrive in batches, numbered
the way the model reads them; and the studio scales to hundreds of projects
with a filtered, foldable tree, a command palette and one shortcuts sheet,
keeps the team's prompt library as templates, and records which creative
won. See **Roadmap** below.

---

Next.js 16 App Router · React 19 · plain CSS · Zustand · pnpm · vitest

---

## Features

### Generate

- **One composer for Image and Video.** A single prompt bar drives both; the
  model you pick decides image or video. `⌘/Ctrl + Enter` submits.
- **33 models in the catalog** — 11 image, 22 video, every one a KIE Market
  model: Nano Banana Pro and 2, Seedream 4.5, GPT Image 2.5, Flux 2 Pro, Grok
  Imagine 2, Ideogram 3, Qwen Image 3 Pro, Z-Image, Crisp Upscale, Remove
  Background; Seedance 2.5 (and Edit), Seedance 2.0 (Fast / Mini), Kling 3.0
  (Omni / Turbo / Standard / Pro / 4K), Kling 2.6 and 2.5, Wan 3.0 (and
  Prime), Wan 2.7 and 2.6, MiniMax H3, Hailuo 2.3 Pro, Grok Imagine Video 1.5,
  PixVerse V6, Happy Horse 1.1 and 1.0. Searchable picker. Five more routes
  (Kling 3.0 Motion Control, Veo 3.1, Topaz Upscale, Topaz Video Upscale) are
  written and tested but gated until a live task proves their docs — KIE
  answered the Topaz routes with an internal error even for its own example
  image on 2026-09-29.
- **Per-model settings.** Aspect ratio, resolution, duration, output format,
  audio, batch size, prompt enhancement — each model declares its own allow-list
  and the studio renders exactly that. No parallel hardcoded list.
- **Media inputs by role.** Start frame, end frame, references, video and audio,
  each with the per-role cap the model declares. Files upload through KIE's own
  file service and become public URLs the generate request can carry; the team
  bucket replaces that scratch space in milestone 3.
- **Batch upload.** Pick or drop several files at once — onto the asset picker
  for the slot it is editing, or onto the composer for the first slot with
  room. Three go up at a time; the picker counts "Uploading 2 of 5"; files the
  slot cannot take are set aside with one line; a failed file names itself and
  the rest land on the shelf. Past the slot's cap the first N are attached and
  the surplus is reported. A file uploaded from inside the picker lands on the
  plane the moment it arrives — the panel stays open so the set can still be
  trimmed — so a press of Generate never finds the strip empty by accident.
- **Frames or references, never both.** Entries whose KIE route refuses a
  start frame beside references (Seedance 2.5 and 2.0, Kling 3.0 Omni, Wan 3.0,
  MiniMax H3, PixVerse V6, Happy Horse, Veo 3.1) declare it on the catalog
  entry, and the studio disables the other group the moment one is attached —
  in the picker, on the tile menus and hotkeys, on a drop — with the line
  saying what to remove. A plane that already holds both — attached before
  the rule, or carried over from another model — says so under the strip and
  Generate waits until one group is removed. A test pins the flag to the
  mapper's own refusal, so the two can never drift.
- **Numbered references, in order.** Every reference, clip and audio track
  wears the position KIE will give it — REF 1, REF 2, VIDEO 1, AUDIO 1 —
  exactly what "Image 1" or "Audio 1" means in a Seedance prompt. Chevrons or
  a drag within the strip reorder them; the picker numbers the tiles in the
  order they were ticked, which is the order they attach; a quiet line under
  the strip says how to refer to them. Frames keep their plain tags.
- **Asset picker.** Attach from your uploads library, the product's shelf or
  any finished run in history — three tabs over one library, filtered to the
  role's kind. `Alt+1…9` attaches the shelf's Nth pinned file as a reference
  from anywhere in the studio outside a text field; the tiles wear their digit.
- **Batch.** Up to 4 results per press. Models with a native count setting use it;
  the rest are submitted once per result, each clearing its own tile.
- **Formats.** The aspect-ratio pill ticks extra ratios to render the same
  plane in — a feed post, a story and a banner from one press, all under one
  batch, up to 12 results per press.
- **Utilities.** Crisp Upscale and Remove Background (and the gated Topaz
  pair) take no prompt: the composer waits on the input alone, and every
  finished image tile offers **Crisp upscale** and **Background removed** in its
  Use menu and on `U` / `B`, submitted with the entry's defaults and recorded
  with their source. Which entries earn a key is written on the catalog entry
  itself, never in a second list.
- **Live run lifecycle.** Skeletons open in the grid on submit, the task is
  polled every 4s until KIE reports success or failure (each model declares how
  long that may take), and each finished result blooms into place on its own
  clock.

### Prompt templates

- **A team-wide library.** The Templates control at the end of the prompt
  opens the team's saved prompts, grouped **This product** / **Team**, with a
  search over titles, bodies and tags, each row showing a one-line preview,
  its tags and the surface it fits (image, video or any). Arrow keys walk the
  rows; Enter inserts the first match; Shift-pick appends to the prompt
  instead of replacing it. A template counts its uses.
- **Variables.** `{{product}}`, `{{offer_url}}` and `{{brand_notes}}` fill
  from the product's brief without asking; any other `{{variable}}` opens a
  tiny fill form — one field each, Enter moves on — and a field left blank
  keeps its braces in the prompt so nothing goes missing quietly.
- **Product brief.** The pencil on a product row in the sidebar edits its
  name, offer URL and brand notes, so the reserved variables have values.
- **Save as template** keeps the current prompt with a title, optional
  product scope and tags. **Starter pack:** while the library is empty the
  panel offers twelve direct-response starters — product hero shot,
  problem → agitate → solve hook, us vs them, UGC testimonial, before / after,
  founder story, unboxing, feature callout, lifestyle in use, social proof
  wall, offer + CTA end card, objection handler — copied into the team's
  library in one press, where they can be edited or removed.
- Also reachable from the command palette ("Templates").

### Verdicts

- **Winner / Testing / Killed on every result**, team-wide. From the tile's
  Use menu, the viewer's Verdict buttons, `W` `T` `X` on the hovered tile or
  in the viewer (the same key again takes the call back), and in bulk from
  the selection bar (**Winner** / **Kill**). The tile wears the word in its
  corner — winner in the accent, since it is state; testing quiet; killed
  struck through — and Compare shows it per column.
- **A note per result** (up to 500 characters) in the viewer, saved when the
  field is left; a refused save keeps the words in the field.
- **The Verdict facet** in Filters shows the wall as All / Winners / Testing /
  Killed / No verdict, with the project's counts.

### Workspace

- **Sidebar for hundreds of projects.** A left column holds the team (name,
  your role, and the gear that opens the team dialog — its lamp is steady
  with a key held and pulses while a run is in flight), the six projects
  opened most recently, then every product with its projects nested as one
  keyboard tree: a filter box narrows both levels as it is typed (`Escape`
  clears), product groups fold shut on their chevron and stay shut per
  browser (the group holding the current project always opens), each product
  row counts its projects, `↑` `↓` move, `←` `→` fold and open, `Enter` opens,
  `Home` / `End` jump. A "+" per product and a "+ New product" row add
  inline, a pencil edits the product's brief, a "…" menu renames or archives
  a project. Below it the Library scopes (Assets, Favorites) and one spend
  line for the last 30 days. It folds to a 56px rail of monograms and icons —
  the toggle at its top or `[` — remembered per browser, and starts folded on
  a narrow screen. On a phone the open column floats over the wall.
- **Command palette.** `⌘/Ctrl + K` — the one chord that also answers from a
  text field — opens one field that reaches everything: projects ("Coffee
  Pods › Retargeting"), products, every model in the catalog (switches the
  composer), the four scopes, and the studio's actions (New project…, New
  product…, fold the sidebar, Team & spend, Keyboard shortcuts, Templates).
  Empty, it lands on Recent, Scopes and Actions; typed, one ranked list —
  label prefix first, then a word of the label, then anywhere, then the
  parent. The item in force is marked Current.
- **Keyboard shortcuts sheet.** `?` (or the palette) lists every studio hotkey
  in four groups — Navigation, Composer, Tiles, Inputs — drawn from the one
  registry in `src/openhiggsfield/hotkeys.ts` that the handlers share, with
  the tool and verdict letters derived from the same tables the grid reads.
- **A simple topbar.** Image and Video as the two surface tabs, search
  (placeholder names `/` and `⌘K`) and Filters. Nothing else.

### Gallery

- **Four scopes** — Image and Video as the topbar's arrow-key-navigable tabs,
  Assets (every finished run) and Favorites in the sidebar's Library.
- **Masonry grid** of real runs at their true aspect ratio, newest first, with a
  gradient placeholder while media loads.
- **Per-tile actions**: use as input, download, retry, favorite, verdict,
  delete, select.
- **One-click references.** Every finished tile is an input: the `+` on a card
  (or in the viewer) names the slot — reference, start frame, end frame — and
  the model that takes it; one press attaches it, switching the composer to that
  model when the current one cannot. Hotkeys `R` `S` `E` on the hovered tile do
  the same without the menu. **Remix** restores the prompt and settings with the
  result attached as a reference; **Variants ×4** re-renders the very same plane
  four more times under one batch, each run remembering its parent.
- **Product shelf.** Any upload can be pinned to the current product from the
  asset picker; pinned packshots and logos sit on their own tab for every
  teammate working that product.
- **Reuse restores model, settings and prompt**, so the same run can be
  re-rendered, not just re-typed.
- **Viewer.** Full-size media with prompt (copy in one click), model, resolved
  settings, timestamp, download, favorite, the verdict and its note, and
  Recreate.
- **Compare.** Two to four picked runs side by side: media as the column heads,
  every dial as a row, the rows that differ marked; clips play and pause
  together, `←` `→` walk the columns, favorite and download per column.
- **Selection mode.** Click a tile's checkbox to enter; shift-click extends a
  range. Compare, bulk download, bulk favorite/unfavorite, bulk Winner / Kill,
  bulk delete. `Esc` exits.
- **Export naming.** Every save is filed as
  `{product}-{project}-{model}-{ratio}-{yyyymmdd}-{id6}.{ext}`; several picked
  runs travel as one `{product}-{project}-{yyyymmdd}.zip` built in the
  browser, with progress, and a refusal by the CDN is reported rather than
  papered over.
- **Undo.** Deletion is reversible for 6 seconds via a bar with a draining
  hairline, in the strip the composer already reserves.
- **Empty states** that hand you a starter prompt instead of a blank grid.

### State and errors

- **The wall is the team's.** Every run is recorded as rows before KIE is
  asked, reconciled from KIE's status endpoint (a callback only hurries that),
  and every result is copied into the team's store the moment it lands — KIE's
  own urls expire within a day. Tiles are scoped by product and project, filter
  by model and member, and search prompts, all on the server; teammates see
  each other's results within seconds. Deletes are undoable; favorites are
  team-wide.
- **Inputs KIE can fetch.** Every attachment carries what stands behind it —
  the team asset of an upload, the result of a run — and the server resolves
  that to a copy KIE can read before submitting; a bare url of the team's own
  store is looked up by its key the same way. A local store's urls never
  leave the machine, so this is what makes references work in development.
- **Failed runs** are recorded as failed tiles carrying KIE's reason and a retry
  that restores the prompt and model. A plane a model cannot serve (an end frame
  without a start frame, frames together with references) is refused before
  anything is submitted, with the reason in the composer — and where the
  catalog declares the rule, at the moment of attaching.
- **Teams.** Sign-in is a magic link to a work email (Google when the
  deployment has credentials); there are no passwords. The first member names
  the team and invites the rest from the team dialog behind the sidebar's gear.
  Owners and admins manage members and the key; members generate.
- **Spend.** The team dialog shows the KIE balance and where the credits went
  over the last 7, 30 or 90 days — by member, by product and per day — from
  the ledger row every settled run leaves.
- **One KIE key per team.** An owner or admin pastes it once; it is proved
  against KIE's credit endpoint, sealed at rest and never sent to a browser.
  `KIE_API_KEY` on the deployment is the fallback for teams without their own.
  The lamp on the sidebar's gear states whether a key is held and whether a
  run is in flight.
- **Hotkeys stand down together.** `R` `S` `E` `V`, `U` `B`, `W` `T` `X`,
  `/`, `[`, `?` and `Alt+1…9` all go quiet while you type and under any open
  dialog, through one shared guard. `⌘/Ctrl + K` is the one chord that also
  answers from a text field.

### Agents

The studio runs the team's Claude Code skills — the creative pipelines
written as skill folders, with their Python scripts, references and
`agents/*.md` subagents — from the web, at `/agents` (the Agents entry under
Library in the sidebar).

This is switched off until `NEXT_PUBLIC_AGENTS=1` is set; see Getting started.

- **Skills library.** An owner or admin drops a `.zip` of a skill folder on
  the Skills tab; the server checks the bundle (size, entry count, no
  escaping paths or symlinks, `SKILL.md` with a name and description at its
  root), normalises it and keeps it — invalid, with its reasons on the card,
  when it fails. Cards show name, version, description, subagents, files and
  size; members see the shelf, admins also delete.
- **New run.** Pick a skill, the project it lands in (the sidebar's current
  project by default), a title, a Markdown brief that becomes the skill's
  first message, and files from the team library for the run's `inputs/`.
  `⌘/Ctrl + Enter` starts it.
- **Runs.** Every run with its skill, project, status, cost, when and by
  whom, filtered by project and refreshed on the wall's cadence; the status
  pill takes the accent only while the agent works or waits on you.
- **The run view.** An activity stream on the left — the agent's words as
  Markdown through a small escaping renderer, tool calls folded to one line
  each (open for input and result), thinking folded, a subagent's whole
  detour nested under its Task, the person's messages, status lines and the
  bill per turn — and the artifacts on the right: images and clips preview,
  documents open in a reader, anything saves, and a picture or clip goes on
  the team wall with one press. Questions the agent asks and the **paid
  gates** — commands that would spend money, held by the worker — are inline
  cards with the options as buttons, Approve / Decline on a command shown in
  full, and the decision kept with who made it. A reply box with attachments
  speaks into an open run; Stop is two presses. The page polls every 1.5 s
  while the agent works and 4 s while it waits, resuming from the last event
  it holds, and announces status changes, questions and errors through the
  studio's live region.
- **The worker.** Runs execute on a long-running worker process
  (`corepack pnpm agent-worker`, `worker/`) that hosts the Claude Agent SDK
  on a machine with Python, ffmpeg and Whisper, one HOME per team, keys only
  through a per-run `.env`. It talks to the web only through the database,
  so the pages work on Vercel with plain polling. See `docs/agent-worker.md`.
  Locally, `AGENT_DEV_WORKER=1` lets `pnpm dev` host the loop itself (the
  embedded database admits one process) and `AGENT_RUNTIME=fake` replays a
  scripted run with no model.

---

## Architecture

Each generate is one object: `{ model, prompt, media, settings }`.

- **The UI builds that object** and hands it to a server action. The action
  re-reads it against the catalog, maps it to KIE's `{ model, input }` body and
  submits it.
- **Server actions are the only caller.** The browser never talks to KIE. Submit
  is `POST /api/v1/jobs/createTask`; status is `GET /api/v1/jobs/recordInfo`.
  Auth is `Authorization: Bearer <key>`. KIE's five task states fold into the
  three the grid draws, and `resultJson` is parsed into image or video urls by
  the entry that owns the model id.
- **The catalog is the source of truth** (`src/generation/catalog/`). Every
  entry declares its settings, its media roles and a `kie` route: the KIE model
  id per shape (text, start frame, first-and-last frames, references), wire-key
  renames, value coercions (`1k` → `1K`, numbers KIE types as strings), and the
  settings a shape drops. The shared mapper in `src/generation/to-kie/shared.ts`
  turns that into the wire; families whose wire is odder (Seedance, Kling 3,
  Wan 3, PixVerse, Veo) register a small custom mapper in the same folder.
- **Every wire body is pinned by a test.** `tests/to-kie/*.test.ts` assert the
  exact createTask input per entry and shape against the KIE docs. `pnpm probe`
  prints them all; with `--live --confirm` it submits one task per entry.
- **Small Zustand stores** — shared image/video prompt, shared image/video
  media (ordered, with `move` for the numbered lists), `settings[modelId]`, the
  extra `formats[modelId]` a press fans out to, a tiny `active` store, a tiny
  `layout` store for the sidebar's fold, folded groups and recent projects
  (persisted per browser), and a one-counter store the palette uses to ask the
  composer for its Templates panel. No store per model.
- **Templates and verdicts are rows.** `prompt_templates` (team, optional
  product, title, body with `{{variables}}`, tags, surface, uses) behind
  `src/server/template-actions.ts`; `results.verdict` / `verdictBy` /
  `verdictAt` / `note` behind `setVerdict` and `setNote` in
  `src/server/gallery-actions.ts`, stamped like favorites so the change feed
  carries them to every teammate's wall.
- **Runs are durable** (`src/server/runs.ts`): `createRun` writes the run and
  its result rows first, then submits under a shared token bucket (KIE allows
  20 task creations per 10 s per account); `reconcileRun` treats `recordInfo`
  as the only truth; `mirrorResult` copies each result into the media store.
  Work that must not be lost lives in a Postgres `jobs` table drained after
  each response, by a dev worker locally, and by `/api/cron/tick` in
  production. `/api/kie/callback` verifies KIE's HMAC and a per-run token and
  never applies the body.
- **Media** lives in Cloudflare R2 when `R2_*` is set, otherwise under
  `.data/media` served by the app. Uploads go browser → store on a presigned
  PUT; the row exists before and is checked after.
- **Accounts** are Better Auth with its organization plugin over Postgres via
  Drizzle: `user`, `session`, `organization`, `member`, `invitation`, plus the
  studio's own `team_settings`. `requireTeam()` in `src/server/team.ts` is the
  first line of every server action and page that touches team data; every
  query downstream is scoped by the team id it returns. `src/proxy.ts` is only
  the optimistic cookie gate.
- **Server actions answer with values, never throws** (`src/server/result.ts`):
  Next hides thrown messages in production, and the studio shows KIE's own
  reason on a failed tile.

## Getting started

You need Node.js 22 or newer. pnpm comes with Node through Corepack.

1. **Install** the dependencies (once):

   ```bash
   corepack enable
   pnpm install
   ```

2. **Create your local settings** from the template:

   ```bash
   cp .env.example .env.local
   ```

   Leave the values empty. A local checkout runs without any of them. The KIE
   key is optional here, because each team sets its own in the studio.

3. **Start the app:**

   ```bash
   pnpm dev
   ```

4. **Sign in** at http://localhost:3000 with your work email. This checkout
   sends no email: the sign-in link is printed in the terminal running
   `pnpm dev`, and it is also listed at http://localhost:3000/api/dev/mail.

5. **Name your team**, then set its KIE key from
   [kie.ai/api-key](https://kie.ai/api-key) in the team dialog (the gear beside
   the team name at the top of the sidebar).

A local checkout uses an embedded Postgres under `.data/pglite` (migrations run
on start), a local media store under `.data/media`, and logged sign-in links.
Delete `.data/` to start from an empty database.

To check a change before you push it, run `pnpm typecheck` and `pnpm test`.

For a deployment, set `DATABASE_URL` (Neon or any Postgres),
`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_SECRET_KEY` and `RESEND_API_KEY`,
then run `pnpm db:migrate` once per schema change and `pnpm build` before
`pnpm start`.

### Agents (off by default)

The Agents page is switched off unless `NEXT_PUBLIC_AGENTS=1` is set in
`.env.local` (restart `pnpm dev` after changing it). With the flag set, the
sidebar gains an Agents entry and the skill upload route answers.

To try it locally, also set `AGENT_DEV_WORKER=1` and `AGENT_RUNTIME=fake`. The
embedded database admits one process, so the dev server then hosts the worker's
loop itself, and a scripted run plays through the run view: a question, a paid
gate, a board on the wall. The real runtime (`AGENT_RUNTIME=claude` with an
`ANTHROPIC_API_KEY`) works the same way, or as its own process with
`pnpm agent-worker` against a Postgres `DATABASE_URL`.

### Environment

```bash
KIE_API_KEY=                          # deployment fallback key, server only
KIE_API_BASE_URL=https://api.kie.ai   # override only if KIE moves hosts
KIE_UPLOAD_BASE_URL=https://kieai.redpandaai.co
NEXT_PUBLIC_KIE_EXPERIMENTAL_MODELS=  # 1 shows the gated entries in the picker
NEXT_PUBLIC_AGENTS=                   # 1 shows the Agents page (off by default)
DATABASE_URL=                         # empty = embedded PGlite under .data/
BETTER_AUTH_SECRET=                   # openssl rand -base64 32
BETTER_AUTH_URL=http://localhost:3000 # the public origin
APP_SECRET_KEY=                       # seals the team key at rest
RESEND_API_KEY=                       # sign-in links and invitations
EMAIL_FROM="Studio <studio@yourdomain.com>"
R2_ACCOUNT_ID=                        # Cloudflare R2; empty = local store
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=
R2_PUBLIC_BASE_URL=                   # the media domain in front of the bucket
APP_PUBLIC_URL=                       # public https origin; enables KIE callbacks
KIE_WEBHOOK_HMAC_KEY=                 # from kie.ai/settings; signs callbacks
CRON_SECRET=                          # bearer for /api/cron/tick
GOOGLE_CLIENT_ID=                     # optional Google sign-in
GOOGLE_CLIENT_SECRET=
ANTHROPIC_API_KEY=                    # the agent worker's model key
AGENT_HOME_ROOT=                      # per-team HOMEs on the worker, outside the checkout; empty = ~/.openhiggsfield/agent-homes
AGENT_RUNTIME=                        # fake replays a scripted run with no model
AGENT_DEV_WORKER=                     # 1 hosts the worker's loop inside pnpm dev
```

### Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server on port 3000 |
| `pnpm build` | Production build |
| `pnpm start` | Serve the production build |
| `pnpm test` | Wire-body tests for every catalog entry, KIE record parsing |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm probe` | Print every entry's createTask body; `--live --confirm --model <id>` submits one |
| `pnpm db:generate` | Write a new SQL migration from the Drizzle schema |
| `pnpm db:migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm auth:schema` | Regenerate the Better Auth tables after changing its plugins |
| `pnpm brand` | Rebuild the icons and OG card in `public/` |
| `pnpm agent-worker` | Runs the agent worker (`docs/agent-worker.md`); `AGENT_RUNTIME=fake` replays a scripted run |

The queue also has production-driver integration tests. Start a disposable local
PostgreSQL database whose name ends in `_test`, then run
`POSTGRES_TEST_URL=postgresql://user@127.0.0.1:5432/studio_test pnpm test tests/server/jobs.postgres.test.ts`.
These tests clear jobs and runs in that test database and stub KIE, so they do not
buy generations. They are skipped when `POSTGRES_TEST_URL` is unset.

---

## Layout

```
src/
  app/          /  is the full-viewport studio; /agents and /agents/[id] are
                the skill runner in the same shell; /login, /invite/[id] and
                /onboarding are the gate pages; /api/auth is Better Auth,
                /api/upload forwards a file to KIE's file service,
                /api/skills takes a skill bundle, /api/dev/mail is the local
                mailbox; base.css owns the document canvas
  server/       auth.ts, team.ts (requireTeam), team-actions.ts, db/ (client,
                schema, migrations under ../drizzle), secrets.ts, email.ts;
                agents.ts is the skill-run core both the actions and the
                worker call, agent-dev-worker.ts hosts the worker's loop in
                the dev server
  generation/   catalog/ (entries + kie routes), to-kie/ (wire mappers),
                kie/client.ts (createTask, recordInfo, credits, upload),
                platform.ts (KIE → studio status), actions.ts, poll.ts, stores/
  openhiggsfield/
                the studio surface: sidebar, topbar, composer, gallery, viewer,
                model picker, settings, asset picker, selection bar, the
                command palette and shortcuts sheet, the prompt-templates
                panel and product dialog, the upload pool and the shared
                hotkey guard and registry — and openhiggsfield.css;
                agents/ is the skill runner's face: skills, new run, runs,
                the run view's stream, cards and artifacts, the Markdown
                renderer and the polling hook
worker/         the agent worker: claims runs, hosts the Claude Agent SDK,
                writes events, holds the paid gates
tests/          vitest: one wire-body file per model family; server/ runs the
                core against an embedded Postgres, worker/ the agent loop
                (end-to-end.test.ts walks a scripted run from upload to the
                wall), agents-ui.test.ts the run view's pure helpers
scripts/        kie-probe.ts
```

---

## Roadmap

1. **KIE swap** (done): catalog, mappers, client, uploads, tests.
2. **Accounts** (done): Postgres + Drizzle, Better Auth organizations, login
   and invites, one sealed KIE key per team.
3. **Durability** (done): runs and results as rows, idempotent submits,
   verified KIE callbacks with polling as the safety net, every result
   mirrored into the team's store, presigned uploads.
4. **Products and projects** (done): a server-side gallery with keyset paging,
   a change feed, filters by model and member, prompt search.
5. **One-click references** (done): use any result as a reference or frame,
   remix, variants, a product-asset shelf, hotkeys.
6. **Team operations** (done): members, roles, key rotation, spend.
7. **Direct-response polish** (done): format fan-out, compare, upscale and
   background removal, export naming, pinned-asset hotkeys.
8. **Workspace and inputs** (done): sidebar with products, projects, library
   and spend; a simple topbar; batch upload with drop zones; frames-or-
   references declared on the catalog and enforced at attach; numbered,
   reorderable references.
9. **Navigation at scale, templates and verdicts** (done): a filtered,
   foldable, keyboard-navigable project tree with recents; a command palette
   and a shortcuts sheet drawn from one registry; team-wide prompt templates
   with variables, a product brief and a starter pack; winner / testing /
   killed verdicts with notes, a facet and bulk calls.
10. **Agents** (done): the team's Claude Code skills uploaded as bundles and
    run from the web — a skills library, briefs with attachments, a live run
    view with the stream, questions and paid gates as inline cards, artifacts
    published to the wall — on a worker that hosts the Claude Agent SDK and
    talks to the studio through the database alone.

---

## Design principles

Dark studio ground, a single lime accent `#d1fe17`, Inter throughout. The chrome
stays neutral so the generated work is the only color on the surface.

1. **The tool disappears into the task** — expression never obscures state or
   affordance.
2. **Accent is state, not decoration** — selection, primary action, liveness only.
3. **Data is data** — settings, counts and durations read in tabular numerals.
   One typeface throughout; no monospace anywhere.
4. **Motion conveys state** — the generation lifecycle, the arrival of a run.
   Nothing loops decoratively.
5. **Every control ships all its states** — hover, focus, active, disabled,
   loading, error, empty.
6. **The catalog is the source of truth** — the studio renders what the model
   declares, never a parallel hardcoded list.

Built for people who work in long sessions, iterating on prompts, inputs and
settings.

### Accessibility

The studio is one page of controls, so it is built to be driven without a
pointer and read without a screen.

- **Landmarks and the way in.** `<html lang="en">`; the sidebar is a
  `<nav aria-label="Workspace">` inside a labelled `<aside>`, the wall and
  the composer sit in `<main>`, and the first Tab stop is a "Skip to composer"
  link that lands the caret in the prompt (or on a utility's first control).
- **A name for everything.** Every icon-only button carries an `aria-label`
  that names the run it acts on; every `data-tip` tooltip has the same words
  in an `aria-label` or in visible text; the strip's slates read "Reference 2
  of 3"; the viewer's note is labelled; no element carries a positive
  `tabindex`.
- **One focus ring.** `:focus-visible` draws a 2px ring in the accent at 60%
  (`--accent-60`, ≥ 3:1 on every surface, including `--s3`). Where an outline
  is removed, a surface of its own takes over at the same strength: the card
  around its open button, the composer and the search fields around their
  inputs, a field's own border.
- **Focus goes back where it came from.** Every `<dialog>` opens with
  `showModal()` (focus trapped) and hands focus back to its opener on close —
  viewer, compare, team, palette, shortcuts, product. The composer's popovers
  (models, inputs, settings, templates and the fill form) and the filter and
  Use menus do the same on Escape; a settings panel opens on the value in
  force.
- **Keyboard everywhere.** The sidebar is one `role="tree"` with a roving
  tab stop; the surface tabs, picker shelves and spend periods are
  `role="tablist"`; the palette is a combobox over a listbox; the tile rail
  stands open on `:focus-within`, and the Use menu and the project menu take
  focus as they open and answer to the arrows, Home, End and Escape. The
  composer goes `inert` while the selection bar stands in its place.
- **Said aloud.** One polite live region announces runs settling — "Nano
  Banana Pro finished · 2 results", "Seedance 2.5 failed — …" — and calls
  made by a letter key ("Winner — a packshot on slate"); the composer's error
  line is `role="alert"`; the selection count is `role="status"`.
- **Contrast.** `--tx3` reads at 5.4:1 on `--s1` and 5.7:1 on the rail;
  `--tx4`, the small-metadata tone, was lifted to hold 4.5:1 on the panels'
  `--s2` too, and a row lit to `--s3` takes its counts one step up with it.
- **Reduced motion.** `prefers-reduced-motion: reduce` squashes every
  animation and transition to a frame — the tile bloom, the fades, the pulse —
  and removes the sweeps and the timer bar that would misread frozen.

The audit is repeatable and needs no test framework: render the surfaces and
list every `button`, `a`, `input`, `[role]` element whose accessible name is
empty (labels, `aria-labelledby`, content, `alt`), every `data-tip` without a
name beside it and every positive `tabindex`; then, in the browser after a
real key press, focus every focusable element in turn and list those that do
not match `:focus-visible` or show no change of outline, box-shadow or border
on themselves or their three nearest ancestors. All lists are empty across the
main surface, the viewer, compare, the palette, the shortcuts sheet, the team
and product dialogs, and the composer's popovers.
