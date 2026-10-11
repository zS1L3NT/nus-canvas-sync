# Agent instructions

`nus-canvas-sync` fetches NUS Canvas, read-only, into the Obsidian vault in the vault directory (`vaultDirectory` in `config.json`) and reports every change since the user last reviewed one, or from an explicitly requested start time.

It runs on a Debian server: a systemd user timer runs `bun run fetch` on a schedule, and the vault can be served over WebDAV, optionally through a Cloudflare tunnel, for the Remotely Save plugin in Obsidian. Each part is toggled under `server` in `config.json`. Development checkouts may be on other machines; `systemctl --user is-active canvas-fetch.timer` prints `active` only on production. See [deploy/README.md](deploy/README.md) and [HANDOFF.md](HANDOFF.md).

When the user asks for a Canvas report, a Canvas update, what changed on Canvas, or a Canvas to Notion update, follow the [canvas-report skill](.agents/skills/canvas-report/SKILL.md) (`$canvas-report` in Codex/T3 Code; `/canvas-report` in Claude Code). Every report request starts with a locked fresh fetch on production; scheduled fetches keep the vault current between reports. Everything below is for working on the project itself; a report never changes the code, and code work never touches Notion.

Follow [STYLE.md](STYLE.md) strictly for every code change, and put future code-style rules there rather than here.

## Rules

- Commit finished, verified work yourself on an `ai/` branch, using the repo's emoji-prefixed message style. Ask before pushing, amending, or rewriting history.
- Never commit personal details: hostnames, domains, IP addresses, personal paths, course lists or secrets. They belong in the gitignored `config.json` or `~/.config/nus-canvas-sync/`; use placeholders in docs and examples.
- Never expose, copy, log, or persist Canvas credentials. `canvas-cli` holds them in the system keyring or its encrypted file store.
- Never create, update, submit, grade, publish, or delete anything in Canvas.
- Preserve stable identifiers, source URLs, timestamps, hashes, and warning details; diffs and indexing depend on them.
- Preserve and display external links found in Canvas content, even when the linked content cannot be downloaded.
- Read warning messages themselves, not counts, and interpret them in context. A warning is a coverage note, not proof of missing content.
- Do not add grades, submissions, quiz attempts, rosters, or other sensitive student data without explicit user direction.
- Do not restore the retired browser/AppleScript scraper, the numbered Finder view, or run logs.

## Layout

| Path | Role |
|---|---|
| `src/sync.ts` | Canvas collection, raw archive, commands |
| `src/vault.ts` | Obsidian vault: naming, notes, link rewriting, course notes, `Home.md` |
| `src/changes.ts` | Unseen-change tracking, readable diffs, warning classification, report |
| `src/tasks.ts` | Normalized assignment and quiz list shared by the vault and `bun run tasks` |
| `src/lib/` | Normalization, hashing, text extraction, naming, dates |
| `deploy/` | `setup.sh`, `teardown.sh` and the systemd user units for the server |
| `config.json` | Courses, directories, timezone, limits, server toggles; gitignored, from `config.example.json` |
| `known-content.json` | Canvas IDs to fetch directly when list endpoints are unavailable |
| `raw/` | Generated machine data: API responses, `documents.jsonl`, manifests, `state.json`, `unseen-changes.json`, `history/` (retained transitions and review cursor) |
| Vault directory | Generated vault; must stay free of implementation details |

`canvas` comes from canvas-cli's release installer (`deploy/setup.sh` puts it in `~/.local/bin`), not from this repository.

## Working on the code

- Keep every Canvas operation read-only. Prefer structured JSON and deterministic, atomic outputs.
- Keep `raw/` optimized for diffing and indexing: stable ordering and IDs, normalized text, explicit metadata, content hashes. A change to how raw documents are rendered shows up as a modification of every affected document, so avoid incidental format changes.
- Keep the vault clean for a person: no numbering, IDs, logs, or machine files; dates in Singapore time; Canvas links rewritten to local notes and files where they exist; external links preserved.
- A change that rewrites most vault notes trips Remotely Save's 50% modification limit, so devices stop syncing until the user confirms one sync. Say so in the PR and in your reply; see [deploy/README.md](deploy/README.md#6-connect-obsidian).
- When the server vault is right but Obsidian is not, suspect the device first: the newest client-written files in `.obsidian/` show when it last synced.
- The vault only removes files it generated (tracked in `raw/<COURSE>/vault.json`); never delete anything else there, such as `.obsidian/` or the user's own notes.
- Never hand-edit `raw/` or the vault. Change the generator and run `bun run vault` (offline) or `bun run fetch`.
- Do not report removals for a resource kind whose collection was incomplete or warned.
- Preserve valid downloads when Canvas temporarily withholds a download URL, and never save an HTML error page as an attachment. A file with no download URL is usually unreleased: keep its metadata and retry it every fetch.
- A missing Pages or Quizzes list often means the course does not use the feature. Classify it as a coverage note, not missing content.
- Delete raw content only with explicit user authorization for the exact targets.
- Keep `deploy/teardown.sh` able to undo everything `deploy/setup.sh` adds, except the archive, the vault and `config.json`.
- Keep both deploy scripts safe to rerun and free of sudo; anything that truly needs root goes in the one `sudo apt install` line it prints. Secrets it prompts for live in `~/.config/nus-canvas-sync/` with mode 600; never read, print or copy them.

## Verification

```sh
bun run verify
bun run doctor
```

Run `bun run vault` to check vault output against the existing archive without contacting Canvas. Run `bun run fetch` only when a live, read-only refresh is needed; note that it adds to the user's unseen changes. On production, use `flock raw/.fetch.lock bun run fetch` so it never overlaps the scheduled fetch, and never run a production command such as `deploy/setup.sh --production` or `systemctl --user` from a development checkout. Review the report's warnings and the vault output before declaring success.
