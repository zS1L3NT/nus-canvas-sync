# NUS Canvas Sync

`nus-canvas-sync` fetches NUS Canvas, read-only, into the Obsidian vault in the vault directory (`vaultDirectory` in `config.json`), and keeps a list of every Canvas change you have not reviewed yet.

It is meant to run on an always-on Debian server: a systemd timer fetches Canvas on a schedule, and the vault can be served over WebDAV, optionally through a Cloudflare tunnel, for the Remotely Save plugin in Obsidian. Each part is toggled under `server` in `config.json`; setting up the server is described in [deploy/README.md](deploy/README.md).

## Daily use

Open the production checkout in your agent and ask for a **Canvas report**. In T3 Code with Codex, invoke `$canvas-report`; in Claude Code, run `/canvas-report`. The agent will:

1. perform a fresh, read-only fetch, then show you every change since your last completed report or your explicitly requested start time: new and edited announcements, assignments, quizzes, pages, files and messages, with date changes and line diffs;
2. reconcile your Notion Task Tracker and the NUS Exams calendar;
3. mark the changes as reviewed.

Every requested report begins with a fresh fetch. Hourly scheduled fetches keep the Obsidian vault current between reports. Fetching never advances the report cursor; recorded changes remain available until and after review.

The shared skill lives in [.agents/skills/canvas-report/SKILL.md](.agents/skills/canvas-report/SKILL.md), which Codex discovers in this repository. Claude Code uses a relative symlink to the same skill under `.claude/skills`, so both agents follow one maintained workflow. If Codex does not show the skill after updating the checkout, restart the agent session. Agents without skill discovery can read that file directly.

Reports need shell access to the production checkout and its archive; a development worktree does not contain the production data. Connect Notion and Google Calendar in the agent you use for the audit. Claude account connectors are not automatically available to Codex or T3 Code.

## The vault

Open the vault named Canvas in Obsidian and start from `Home.md`, which lists courses and everything due next.

```
<vault directory>/
  Home.md
  CS2030S/
    CS2030S.md        deadlines, modules in Canvas order, syllabus
    Assignments/      one note per assignment (due, opens, closes, points in properties)
    Quizzes/
    Announcements/    2026-10-02 PE1 Reminder.md
    Inbox/
    Pages/
    Files/            Canvas folder tree
    Attachments/      images and hidden files embedded in notes
```

Canvas links inside notes point at the local note or file when it exists, so the vault works offline. Times are in Singapore time. On filesystems with clones (APFS, Btrfs, XFS), vault files share blocks with `raw/`.

Generated notes do not have `created` or `updated` properties. Their file modification dates follow Canvas update dates where available, falling back to creation dates. Inbox notes use the conversation's latest message timestamp. `Home.md` and course overview notes use the time their generated content changes; rebuilding identical summaries preserves their file dates. Filesystem creation dates are not rewritten.

Quizzes and announcements get their Canvas dates through read-only GraphQL queries because the usual API responses omit them. These queries request only identifiers and timestamps, never grades or submissions. Failed or incomplete timestamp requests retain previously collected dates and produce warnings. `bun run vault` uses saved dates offline and restores source note contents and modification dates after edits.

In Notebook Navigator, disable **Use frontmatter metadata** under **Frontmatter fields** and sort by **Date edited**, newest first. Set the same sort order in each folder that has a saved override. Sorting uses file modification dates. The generator leaves `.obsidian/` settings and user-authored notes alone.

A fetch only replaces or removes files it generated. Your own notes and `.obsidian/` settings in the vault are left alone; avoid editing generated notes, because the next fetch overwrites them.

## Commands

```sh
bun run fetch                   # read Canvas, update raw/ and the vault, print unseen changes
bun run fetch --course CS2030S  # one course
bun run fetch --metadata-only   # skip file downloads
bun run changes                 # reprint unseen changes without contacting Canvas
bun run changes --reviewed --through '<report-end-timestamp>' # acknowledge the report
bun run tasks                   # JSON of every assignment and quiz with Singapore-time dates
bun run vault                   # rebuild the vault from raw/ without contacting Canvas
bun run doctor
bun run verify
```

On the server, run a manual fetch as `flock raw/.fetch.lock bun run fetch` so it waits for the scheduled one.

## Setup

```sh
sudo apt install curl unzip git util-linux   # once
deploy/setup.sh                              # bun, canvas-cli, dependencies and config.json, no sudo
canvas auth token set nus --url https://canvas.nus.edu.sg
bun run doctor
```

`canvas-cli` keeps the Canvas token in the system keyring, or its own encrypted file where there is none; nothing secret is stored here. Courses, directories, the timezone and the server toggles live in `config.json`, which is gitignored because it holds personal details; `config.example.json` is the template.

## Raw archive

`raw/` is machine data for diffing and AI indexing: lossless API responses, `documents.jsonl` (normalized records), `file-manifest.json`, extracted text under `content/text/`, `state.json`, and `unseen-changes.json`. Grades, submissions, quiz attempts and rosters are deliberately not collected. Inbox collection is limited to each course's conversations and never marks them read.

## Report windows

Scheduled and report-triggered fetches retain timestamped transitions under `raw/history/`. `bun run changes` reports changes since the last reviewed report; each transition remains visible even if a later fetch reverses it. Fetching and printing a report do not advance the review cursor.

Choose a start time with an explicit timezone:

```sh
bun run changes --since '2026-10-06T12:00:00+08:00'
bun run changes --since '2026-10-06T12:00:00+08:00' --through '2026-10-10T08:00:00Z'
```

Explicit windows include both endpoints and use the Canvas update time saved with each transition. Removals and changes without a usable or changed Canvas timestamp use detection time. Default reports use detection time so late discoveries are not lost after review. A historical endpoint includes only data collected by that endpoint. Resource identifiers, source URLs, before/after snapshots, hashes, coverage notes and warnings remain in the retained fetch records. Reports use the coverage recorded at their selected end. A failed fetch retains successfully recorded course transitions and identifies its incomplete coverage.

After reading the complete report, acknowledge its exact end timestamp:

```sh
bun run changes --reviewed --through '<report-end-timestamp>'
```

Acknowledgement refuses if a newer collection has been recorded. It advances a separate cursor without deleting history, so explicit historical reports remain repeatable. History starts fresh with the first fetch after deployment: existing course archives establish baselines, and old pending differences are not imported. Requests before retained history begins fail explicitly; a new course's first fetch is a baseline, not reconstructed history. Offline vault generation does not change history or the review cursor.
