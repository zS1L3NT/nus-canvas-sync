---
name: canvas-report
description: Show every Canvas change since the user last reviewed one, as fetched on a schedule into the Obsidian vault, then reconcile the Notion Task Tracker and the NUS Exams Google Calendar. Use whenever the user asks for a Canvas report, a Canvas update, what changed on Canvas, or a Canvas to Notion update.
---

# Canvas report

Canvas is read-only. The project does the Canvas work deterministically, and on the production server a systemd timer runs `bun run fetch` on a schedule; your job is to present the changes and keep Notion and the exam calendar accurate.

## Agent access

Use shell access to the production checkout for all project commands, even when the agent session starts in a development worktree. Read that checkout's `AGENTS.md` first. Use the Notion and Google Calendar tools available in the current agent; do not assume Claude account connectors are available elsewhere. If a required integration is unavailable, show the Canvas changes and state which audit checks could not be performed. Do not claim those checks passed or that external updates were made.

## 1. Report

Run this from the production checkout, where `systemctl --user is-active canvas-fetch.timer` prints `active`; a development checkout has its own, usually empty, `raw/`.

Every report request starts with a fresh, read-only fetch: run `flock raw/.fetch.lock bun run fetch`, which waits for any running scheduled fetch. This has standing authorization; do not ask first. Hourly scheduled fetches keep the Obsidian vault current between reports. The requested start time selects the history window; the fresh fetch supplies the current endpoint. Do not acknowledge a report if this refresh fails; state the failure and clearly label any report of previously collected data.

Run `bun run changes` for every recorded transition since the last reviewed report. If the user supplies a start time, use `bun run changes --since <ISO-8601 timestamp with timezone>`; interpret an unqualified local time in Singapore time. For example, 6 October 2026 at noon is `2026-10-06T12:00:00+08:00`. Explicit start times are inclusive. An optional `--through <timestamp>` selects an earlier end; the end is inclusive. The default review cursor is exclusive, so already reviewed events are not repeated.

Record the exact timestamp printed as `Report through:`; the human-readable header shows the same time in Singapore time. Inspect every retained transition, including reversals, then group related transitions for presentation using step 2. Explicit date windows use the saved Canvas update time when usable; removals and changes with missing or unchanged Canvas timestamps use detection time. Default reports include every newly detected transition since review, including late discoveries. Historical endpoints include only data collected by that endpoint. Do not use current Canvas `updated_at` timestamps to reconstruct missing history.

If selectable history is unavailable or the requested start predates its coverage, explain the limitation plainly. Do not substitute a timestamp-filtered current snapshot or acknowledge an incomplete historical report. History starts fresh at the first fetch after deployment; old pending differences are not imported. The first collection of each course establishes a baseline, not a historical change list.

The report uses the course coverage recorded at its selected end. If the latest fetch did not complete, it explicitly limits coverage to recorded course collections. If the last fetch is well past `server.fetchSchedule`, say so, and on production check `systemctl --user status canvas-fetch` and `journalctl --user -u canvas-fetch -n 50` for the failure.

If the last fetch failed or a course errored out, say so plainly and limit every later claim to the courses that completed.

If the user only wants to see changes, stop after step 2 and step 5.

## 2. Show the changes

Write a brief report the user can scan during class. Start with the report's date/time window and fresh-fetch time in Singapore time, then one short sentence stating what was synced and which integrations were checked or unavailable.

- Give each module with new Canvas content or material changes its own header, using the module code and a useful topic or course name. Keep all Canvas content for that subject under that header. Omit unchanged modules; state fetch coverage in the opening sentence.
- Use one short bullet per meaningful content item: a lecture release, tutorial revision, assignment update, quiz change, or announcement. Lead with the idea and its practical consequence, then its change time. Link the idea to its canonical HTTPS Canvas page, assignment, quiz or file URL using clickable Markdown links. Use filenames only when needed for a required submission or to distinguish content.
- Combine PDF, PowerPoint, summary and other versions of the same release into one bullet, such as “Lecture 11: Counting and Probability II released — 11 Oct, 7:34 pm.” Combine repeated updates to the same item into one bullet with its latest change time, or a time range when the sequence matters. Preserve meaningful intermediate changes, reversals and distinct requirements in that bullet.
- Keep confirmed deadlines, availability, venues, required links and actionable instruction changes. When history contains only timestamp or metadata changes, say no readable instruction or date change was recorded. A grouped bullet must account for every related transition; unrelated items retain separate bullets.
- Let the content determine the detail. Use a short nested list or extra sentence when a change needs it, such as removed quiz instructions. Concision must preserve information needed to act; there is no fixed bullet count or word limit.
- Keep warnings at the top of **Audit summary** as specified in step 4. Keep subject-specific context that affects the meaning of a content change in that module's bullet.

## 3. Notion and calendar audit

Skip this step only if the user asked to omit it.

### Sources

1. **NUS Journey > Module Planning**: read the **Canvas to Notion** section of every in-scope module page first. Those notes are durable course-specific rules for matching, ignored records, warning interpretation and task conversions, and they override the defaults below.
2. **NUS Journey > Task Tracker**: enumerate only current, non-archived pages, preferably through a database view or a query that excludes archived rows. Inspect each page's module relation, title, date and body. If complete enumeration is unavailable, limit the stated coverage rather than opening relation targets, which may be deleted pages.
3. **NUS Exams** Google Calendar, when calendar access is available.
4. `bun run tasks`: JSON of every assignment and quiz per course, with Canvas IDs, URLs, effective overrides and dates in Singapore time (`+08:00`). Classic quizzes are merged with their backing assignment (`assignment_id`). `note` is the vault note holding the full instructions.
5. The vault notes (`<vault directory>/<COURSE>/...`) for instructions, announcements and attachments. Use `raw/<COURSE>/documents.jsonl` and `raw/<COURSE>/content/text/files/` only to resolve an ambiguity or read attachment text.

### Required checks

1. **Date accuracy.** Compare every current Notion task date with the Canvas due date and availability window, including any override returned for the user. List each discrepancy. Change a date only when the user authorized date writes for this report, and then only to dates Canvas confirms.
2. **Task completeness.** For each course, compare Canvas assignments and quizzes with current Task Tracker pages and list every missing task. Separately flag uncertain matches, duplicates and apparent extras. Do not resolve them by creating, changing or deleting anything.
3. **Page information.** Keep each matched task page body a concise, current reference: submission requirements, instructions, grading or rubric details, availability restrictions, required links and attachment summaries.
4. **Exam completeness.** Compare important one-time, high-weight examinations with **NUS Exams** and report missing, conflicting or unconfirmed events.

### Matching

- Match by Canvas ID or source URL. Title, course and date are supporting evidence only; never accept a title-only match. Always verify the Notion module relation, especially for repeated names such as tutorials, quizzes, lectures and diagnostics.
- Apply any conversion rule from the module's **Canvas to Notion** notes before reporting a missing task, duplicate, extra or removal. When a rule says a new Canvas record continues an existing task, keep the existing Notion task.
- A dated mention in prose, a syllabus schedule, an external module link or an archived module item is evidence to investigate, not a task. Treat it as current only when a live Canvas assignment or quiz, a current explicit announcement, or the user confirms it; otherwise leave it out of missing-task warnings.
- Do not infer student visibility from a module's `published` flag alone. Cross-check it against the assignment or quiz record and `content_details`, and call the flag unreliable when they disagree.
- Attach an announcement to a task only after verifying its Canvas URL or ID and the module relation, never by title alone. Fold current announcement details into the task page and replace whatever they supersede.

### Writing to Notion

- Standing permission covers the full body of an existing, matched Task Tracker page: add, rewrite, reorder, merge or remove blocks so it reads as one clean, current reference rather than a change log.
- Keep the Canvas source URL and important external links as labelled, clickable links.
- Put dates in the `Due date` property (when authorized) rather than repeating them in the body, unless a date explains a policy, conflict or sequence.
- Replace superseded Canvas-derived instructions instead of keeping history. Keep history only when it is still operationally relevant, such as a correction policy or a required sequence of steps.
- Preserve the user's own notes and planning, integrating them without changing their meaning. When provenance or accuracy is uncertain, leave the content and report it.
- If attachment text is unreadable, keep the metadata or link and say the content could not be read; do not drop older instructions because an unreadable attachment might supersede them.
- Do not upload course attachments unless the user explicitly authorizes it.
- When Canvas and Notion conflict outside the date field, fix clearly stale Canvas-derived content and report ambiguous conflicts unchanged.
- Store new course-specific decisions on the module page under **Canvas to Notion**, organised under short level-three headings such as Tutorials, Assignments, Quizzes, Overrides, Ignored items and Warning handling. Consolidate rather than append.

### Never

- Never write to Canvas.
- Never open, search, read, edit, move or delete subpages nested in a Task Tracker page. They are the user's private handwritten notes. This does not restrict maintaining the parent page body.
- Never create a task or change any database property without explicit permission for that specific action in this report.
- Never delete a Notion page, property or anything outside a matched task page body without explicit approval. Absence from Canvas, a partial fetch or a warning is never deletion approval.
- Deleted or archived Notion pages are out of scope entirely: never fetch them, compare them, follow their links, count them, classify them, or mention them. If a tool says a page is deleted or archived, stop processing it and do not unarchive it.
- Never use Google Calendar for assignments, quizzes, tutorials, diagnostics, study windows or anything spanning a period; those belong in Notion. Only touch the **NUS Exams** calendar, only for important one-time, high-weight exams, only with calendar-write authorization, and only from a confirmed date and time. Never create an event from a TBA, ambiguous, inconsistent or stale source. Never delete or cancel an event without explicit approval.
- Never hand-edit `raw/` or the vault. They change only through `bun run fetch`. Do not change implementation files or `config.json` during a report.

### Warnings

The change report already turns routine Canvas responses into **Coverage notes**: unused Pages or Quizzes, a restricted Files tab, unreleased files (retried every fetch) and links to deleted files. These are not missing content. Anything under **Warnings** needs reading in full and interpreting in context. A warning can reflect access control or unreleased content; never conclude a task is absent when the relevant collection was incomplete. Apply the module notes' warning rules before reporting.

## 4. Report

After the module sections from step 2, use these sections with short bullets:

1. **Notion updates**: material task-page changes and calendar actions. These can be grouped across modules. Name each changed page and what was added, replaced, removed or consolidated; omit routine checks.
2. **Still requiring review**: every unresolved date, uncertain match, relevant persistent warning, or other item needing the user, including warnings intentionally kept under watch. Prefix each bullet with its module when applicable.
3. **Audit summary**: start with **Warnings**, prefixed by module. Preserve the full message of every warning and add a short contextual interpretation where needed. Include coverage notes only when new or when they affect a conclusion; say “Warnings: none” when there are none. Follow with bullets for missing, uncertain, duplicate or extra tasks by course (or that there were none); date properties changed (or that none were); anything else created or updated; confirmation that nothing was deleted; and any limits on audit coverage. Keep material page edits in Notion updates rather than repeating them here.

Do not present skipped calendar work as a warning.

## 5. Mark the changes reviewed

Once the report accounting for all changes has been shown to the user, run `bun run changes --reviewed --through <last_sync>` with the report end timestamp noted in step 1. This advances the default review cursor and never deletes history. An intentionally historical report ending before the current cursor must not move the cursor backwards. The next report then starts from this point. If it refuses because a scheduled fetch ran in between, run `bun run changes` again, show the user what is new, and retry with the new `last_sync`. Do not mark changes reviewed if no report was produced.
