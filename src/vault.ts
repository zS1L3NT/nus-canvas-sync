import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inboxConversationOrder, inboxMarkdown } from "./archive-helpers.ts";
import {
  atomicWrite,
  byPosition,
  canvasDate,
  displayDate,
  htmlToMarkdown,
  localDateTime,
  markdownDestination,
  readJson,
  setFileMtime,
  uniqueNames,
  vaultName,
  writeJson,
  zonedInstant,
} from "./lib.ts";
import { courseTasks } from "./tasks.ts";
import type { CanvasModuleItem, CanvasTask, CourseData, FileEntry } from "./types.ts";

export interface VaultCourse {
  data: CourseData;
  fileEntries: FileEntry[];
  rawDirectory: string;
}

export interface VaultPlan {
  code: string;
  note: string;
  files: Map<number, string>;
  assignments: Map<number, string>;
  quizzes: Map<number, string>;
  pages: Map<string, string>;
  announcements: Map<number, string>;
  inbox: Map<number, string>;
}

const linkKinds: Record<string, string> = {
  announcements: "announcement",
  assignments: "assignment",
  discussion_topics: "announcement",
  files: "file",
  pages: "page",
  quizzes: "quiz",
};

const downloadedStatuses = new Set(["downloaded", "unchanged", "legacy-preserved"]);

const submissionLabels: Record<string, string> = {
  discussion_topic: "discussion",
  external_tool: "external tool",
  media_recording: "media recording",
  none: "no submission",
  on_paper: "on paper",
  online_quiz: "quiz",
  online_text_entry: "text entry",
  online_upload: "file upload",
  online_url: "website URL",
};

function isRootFolder(folder: { name?: string; full_name?: string }): boolean {
  return /^course files$/i.test(String(folder.name || folder.full_name || ""));
}

function noteMap<T>(
  folder: string,
  items: T[],
  name: (item: T) => string,
  id: (item: T) => number,
): Map<number, string> {
  const names = uniqueNames(items, (item) => `${name(item)}.md`, id);
  return new Map(items.map((item) => [id(item), `${folder}/${names.get(item)}`]));
}

function datedName(value: unknown, title: unknown, timezone: string): string {
  const day = localDateTime(value, timezone).slice(0, 10);
  return vaultName(day ? `${day} ${String(title ?? "")}` : title);
}

export function planVault({ data, fileEntries }: VaultCourse, timezone: string): VaultPlan {
  const records = new Map(data.files.map((file) => [Number(file.id), file]));
  const folders = new Map(data.folders.map((folder) => [Number(folder.id), folder]));
  const folderPath = (folderId: unknown): string | null => {
    const parts: string[] = [];
    let current = folders.get(Number(folderId));
    while (current && !isRootFolder(current)) {
      parts.unshift(vaultName(current.name));
      current = folders.get(Number(current.parent_folder_id));
    }
    return current ? parts.join("/") : null;
  };
  // Hidden files are page images and similar embeds; files in unreadable folders still belong under Files.
  const downloaded = fileEntries.filter((entry) => downloadedStatuses.has(entry.status));
  const directories = new Map(
    downloaded.map((entry) => {
      const record = records.get(Number(entry.canvas_id));
      if (record?.hidden || record?.hidden_for_user) return [entry, "Attachments"];
      const folder = record?.folder_id ? folderPath(record.folder_id) : null;
      return [entry, folder ? path.posix.join("Files", folder) : "Files"];
    }),
  );
  const files = new Map<number, string>();
  for (const directory of new Set(directories.values())) {
    const entries = downloaded.filter((entry) => directories.get(entry) === directory);
    const names = uniqueNames(
      entries,
      (entry) => vaultName(entry.name),
      (entry) => Number(entry.canvas_id),
    );
    for (const entry of entries) files.set(Number(entry.canvas_id), `${directory}/${names.get(entry)}`);
  }

  const quizIds = new Set(data.quizzes.map((quiz) => Number(quiz.id)));
  const quizzes = noteMap(
    "Quizzes",
    data.quizzes,
    (quiz) => vaultName(quiz.title),
    (quiz) => Number(quiz.id),
  );
  const assignments = noteMap(
    "Assignments",
    data.assignments.filter((assignment) => !assignment.quiz_id || !quizIds.has(Number(assignment.quiz_id))),
    (assignment) => vaultName(assignment.name),
    (assignment) => Number(assignment.id),
  );
  for (const assignment of data.assignments) {
    const quiz = assignment.quiz_id ? quizzes.get(Number(assignment.quiz_id)) : undefined;
    if (quiz) assignments.set(Number(assignment.id), quiz);
  }

  const modulePages = new Set(
    data.modules.flatMap((module) => (module.items || []).map((item) => item.page_url).filter(Boolean)),
  );
  const pages = data.pages.filter((page) => modulePages.has(page.url) || String(page.body || "").trim());
  const pageNames = uniqueNames(
    pages,
    (page) => `${vaultName(page.title)}.md`,
    (page) => Number(page.page_id) || 0,
  );
  return {
    code: data.configuredCourse.code,
    note: `${data.configuredCourse.code}.md`,
    files,
    assignments,
    quizzes,
    pages: new Map(pages.map((page) => [page.url, `Pages/${pageNames.get(page)}`])),
    announcements: noteMap(
      "Announcements",
      data.announcements,
      (announcement) => datedName(announcement.posted_at, announcement.title, timezone),
      (announcement) => Number(announcement.id),
    ),
    inbox: noteMap(
      "Inbox",
      data.inbox,
      (conversation) =>
        datedName(
          conversation.last_message_at || conversation.updated_at,
          conversation.subject || "Conversation",
          timezone,
        ),
      (conversation) => Number(conversation.id),
    ),
  };
}

// Every plan path is relative to the course folder inside the vault.
function planTarget(plan: VaultPlan, kind: string, id: unknown): string | undefined {
  if (kind === "course" || kind === "module") return plan.note;
  if (kind === "page") return plan.pages.get(String(id));
  if (kind === "file") return plan.files.get(Number(id));
  if (kind === "assignment") return plan.assignments.get(Number(id));
  if (kind === "quiz") return plan.quizzes.get(Number(id));
  if (kind === "announcement") return plan.announcements.get(Number(id));
  if (kind === "inbox") return plan.inbox.get(Number(id));
  return undefined;
}

export function vaultPathForDocument(
  plan: VaultPlan,
  documentId: string,
  metadata: Record<string, unknown> = {},
): string {
  const [, kind = "", id] = documentId.split(":");
  const target = planTarget(plan, kind, kind === "page" ? metadata.page_url : id);
  return target ? `${plan.code}/${target}` : "";
}

function frontmatter(fields: Record<string, string | number | null | undefined>): string {
  const lines = Object.entries(fields)
    .filter(
      ([key, value]) =>
        (value !== null && value !== undefined && value !== "") ||
        ((key === "created" || key === "updated") && value === null),
    )
    .map(([key, value]) =>
      value === null
        ? `${key}:`
        : typeof value === "number" || /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(String(value))
          ? `${key}: ${value}`
          : `${key}: ${JSON.stringify(value)}`,
    );
  return `---\n${lines.join("\n")}\n---\n\n`;
}

// Obsidian's date & time property type: unquoted local time to the second, without an offset.
function noteDates(
  created: unknown,
  updated: unknown,
  timezone: string,
): { created: string | null; updated: string | null } {
  const timestamp = (value: unknown): string | null => {
    const valid = canvasDate(value);
    if (!valid) return null;
    return `${localDateTime(valid, timezone)}:${String(new Date(valid).getUTCSeconds()).padStart(2, "0")}`;
  };
  return { created: timestamp(created), updated: timestamp(canvasDate(updated) ?? created) };
}

async function writeSummary(filePath: string, content: string, timezone: string): Promise<void> {
  const previous = await readFile(filePath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return "";
  });
  const attributes = await stat(filePath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  });
  const header = previous.match(/^---\n([\s\S]*?)\n---\n/);
  const saved = (key: string) =>
    zonedInstant(header?.[1]?.match(new RegExp(`^${key}: "?([^"\\n]+)"?$`, "m"))?.[1], timezone);
  const withoutDates = header
    ? previous.replace(header[0], header[0].replace(/^(?:created|updated):[^\n]*\n/gm, ""))
    : previous;
  const created = saved("created") ?? attributes?.birthtime.toISOString() ?? new Date().toISOString();
  const unchanged =
    withoutDates === content || (!header && previous === content.replace(/^---\n[\s\S]*?\n---\n\n/, ""));
  const updated = unchanged
    ? (saved("updated") ?? attributes?.mtime.toISOString() ?? created)
    : new Date().toISOString();
  const dates = noteDates(created, updated, timezone);
  const metadata = frontmatter(dates);
  // Dates stay the last two properties, after any the note already has.
  const next = content.startsWith("---\n")
    ? content.replace("\n---\n", `\n${metadata.slice(4, -6)}\n---\n`)
    : `${metadata}${content}`;
  await atomicWrite(filePath, next, zonedInstant(dates.updated, timezone) ?? updated);
}

function courseLink(plan: VaultPlan): string {
  return `[[${plan.code}/${plan.code}|${plan.code}]]`;
}

function linkLabel(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("|", "\\|");
}

function noteLink(label: unknown, target: string): string {
  return `[${linkLabel(label)}](${markdownDestination(target)})`;
}

interface DeadlineRow {
  due: string | null;
  task: CanvasTask;
  audience: string | null;
}

function deadlineRows(tasks: CanvasTask[]): DeadlineRow[] {
  return tasks
    .flatMap((task) => {
      const overrides = task.overrides
        .filter((date) => canvasDate(date.due_at))
        .map((date) => ({ due: canvasDate(date.due_at), task, audience: date.audience }));
      return task.due_at || !overrides.length ? [{ due: task.due_at, task, audience: null }, ...overrides] : overrides;
    })
    .sort(
      (left, right) =>
        (left.due ? new Date(left.due).getTime() : Number.MAX_SAFE_INTEGER) -
        (right.due ? new Date(right.due).getTime() : Number.MAX_SAFE_INTEGER),
    );
}

export function taskNote(plan: VaultPlan, task: CanvasTask): string | undefined {
  return task.kind === "quiz" ? plan.quizzes.get(task.id) : plan.assignments.get(task.id);
}

async function cloneFile(source: string, destination: string, mtime?: string): Promise<boolean> {
  const from = await stat(source).catch(() => null);
  if (!from) return false;
  const to = await stat(destination).catch(() => null);
  if (to && to.size === from.size && Math.abs(to.mtimeMs - from.mtimeMs) < 1) return true;
  await mkdir(path.dirname(destination), { recursive: true });
  await rm(destination, { force: true });
  // Where the filesystem supports clones (APFS, Btrfs, XFS), the vault shares blocks with raw/; elsewhere this copies.
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await setFileMtime(destination, mtime || from.mtime);
  return true;
}

async function pruneEmptyDirectories(directory: string, root: string): Promise<void> {
  for (let current = directory; current.startsWith(`${root}${path.sep}`); current = path.dirname(current)) {
    const entries = await readdir(current).catch(() => null);
    if (!entries || entries.some((entry) => entry !== ".DS_Store")) return;
    await rm(current, { recursive: true, force: true });
  }
}

export async function writeVault(
  vaultDirectory: string,
  timezone: string,
  course: VaultCourse,
  plan: VaultPlan,
): Promise<void> {
  const { data, fileEntries, rawDirectory } = course;
  const directory = path.join(vaultDirectory, plan.code);
  const generated: string[] = [];
  const write = async (relative: string, content: string, mtime?: unknown): Promise<void> => {
    generated.push(relative);
    await atomicWrite(path.join(directory, relative), content, canvasDate(mtime) ?? undefined);
  };
  const date = (value: unknown) => localDateTime(value, timezone);
  const canvasTarget = (href: string): string | undefined => {
    const match = href.match(
      /^(?:https?:\/\/canvas\.nus\.edu\.sg)?(?:\/api\/v1)?\/courses\/(\d+)\/(files|assignments|quizzes|pages|discussion_topics|announcements)\/([^/?#]+)/i,
    );
    if (!match || Number(match[1]) !== Number(data.course.id)) return undefined;
    const [, , type = "", id = ""] = match;
    return planTarget(plan, linkKinds[type.toLowerCase()] ?? "", decodeURIComponent(id));
  };
  const markdown = (html: unknown, note: string): string => {
    const relative = (target: string) => path.posix.relative(path.posix.dirname(note), target);
    return htmlToMarkdown(
      html,
      (fileId, source) => {
        const target = fileId === null ? undefined : plan.files.get(fileId);
        return target ? relative(target) : source;
      },
      (href) => {
        const target = canvasTarget(href);
        return target ? relative(target) : null;
      },
    );
  };

  for (const entry of fileEntries) {
    const target = plan.files.get(Number(entry.canvas_id));
    if (
      target &&
      (await cloneFile(path.join(rawDirectory, entry.local_path), path.join(directory, target), entry.updated_at))
    )
      generated.push(target);
  }

  const tasks = courseTasks(data);
  for (const task of tasks) {
    const note = taskNote(plan, task);
    if (!note) continue;
    const source =
      task.kind === "quiz"
        ? data.quizzes.find((quiz) => quiz.id === task.id)
        : data.assignments.find((assignment) => assignment.id === task.id);
    const groupDates = task.overrides
      .filter((override) => override.due_at || override.unlock_at || override.lock_at)
      .map((override) => {
        const parts = [
          canvasDate(override.due_at) ? `due ${displayDate(override.due_at, timezone)}` : "",
          canvasDate(override.unlock_at) ? `opens ${displayDate(override.unlock_at, timezone)}` : "",
          canvasDate(override.lock_at) ? `closes ${displayDate(override.lock_at, timezone)}` : "",
        ].filter(Boolean);
        return parts.length ? `> - ${override.audience}: ${parts.join(" · ")}` : "";
      })
      .filter(Boolean);
    await write(
      note,
      [
        frontmatter({
          course: courseLink(plan),
          type: task.kind,
          due: date(task.due_at),
          opens: date(task.unlock_at),
          closes: date(task.lock_at),
          points: task.points ?? undefined,
          submission: task.submission_types
            .map((type) => submissionLabels[type] ?? type.replaceAll("_", " "))
            .join(", "),
          canvas: task.url,
          ...noteDates(source?.created_at, source?.updated_at, timezone),
        }),
        groupDates.length ? `> [!info] Dates for your group\n${groupDates.join("\n")}\n\n` : "",
        markdown(source?.description, note),
      ].join(""),
      canvasDate(source?.updated_at) ?? source?.created_at,
    );
  }

  for (const page of data.pages) {
    const note = plan.pages.get(page.url);
    if (!note) continue;
    await write(
      note,
      `${frontmatter({
        course: courseLink(plan),
        type: "page",
        canvas: page.html_url || `https://canvas.nus.edu.sg/courses/${data.course.id}/pages/${page.url}`,
        ...noteDates(page.created_at, page.updated_at, timezone),
      })}${markdown(page.body, note)}`,
      canvasDate(page.updated_at) ?? page.created_at,
    );
  }

  for (const announcement of data.announcements) {
    const note = plan.announcements.get(Number(announcement.id));
    if (!note) continue;
    const updated = canvasDate(announcement.updated_at) ?? canvasDate(announcement.created_at);
    await write(
      note,
      `${frontmatter({
        course: courseLink(plan),
        type: "announcement",
        posted: date(announcement.posted_at),
        canvas: announcement.html_url,
        ...noteDates(announcement.created_at, updated, timezone),
      })}${markdown(announcement.message, note)}`,
      updated,
    );
  }

  for (const conversation of [...data.inbox].sort(inboxConversationOrder)) {
    const note = plan.inbox.get(Number(conversation.id));
    if (!note) continue;
    const lastMessage = conversation.last_message_at || conversation.updated_at;
    const firstMessage = conversation.messages
      ?.map((message) => canvasDate(message.created_at))
      .filter((date): date is string => date !== null)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    await write(
      note,
      `${frontmatter({
        course: courseLink(plan),
        type: "message",
        canvas: conversation.html_url || `https://canvas.nus.edu.sg/conversations/${conversation.id}`,
        ...noteDates(canvasDate(conversation.created_at) ?? firstMessage, lastMessage, timezone),
      })}${inboxMarkdown(conversation, (html) => markdown(html, note))}\n`,
      lastMessage,
    );
  }

  generated.push(plan.note);
  await writeSummary(path.join(directory, plan.note), courseNote(data, plan, tasks, timezone, markdown), timezone);

  const manifestPath = path.join(rawDirectory, "vault.json");
  const current = new Set(generated.map((relative) => relative.toLocaleLowerCase("en")));
  for (const stale of (await readJson<{ paths: string[] }>(manifestPath, { paths: [] })).paths) {
    // APFS is case-insensitive, so a case-only rename must not delete the renamed note.
    if (current.has(stale.toLocaleLowerCase("en"))) continue;
    await rm(path.join(directory, stale), { force: true });
    await pruneEmptyDirectories(path.dirname(path.join(directory, stale)), directory);
  }
  await writeJson(manifestPath, { paths: [...generated].sort() });
}

function courseNote(
  data: CourseData,
  plan: VaultPlan,
  tasks: CanvasTask[],
  timezone: string,
  markdown: (html: unknown, note: string) => string,
): string {
  const lines = [
    `${frontmatter({ type: "course", canvas: `https://canvas.nus.edu.sg/courses/${data.course.id}` })}**${data.configuredCourse.name}**`,
    "",
  ];

  const rows = deadlineRows(tasks);
  if (rows.length) {
    lines.push("## Deadlines", "", "| Due | Task |", "|---|---|");
    for (const row of rows) {
      const note = taskNote(plan, row.task);
      const title = row.audience ? `${row.task.title} (${row.audience})` : row.task.title;
      lines.push(
        `| ${row.due ? displayDate(row.due, timezone) : "No due date"} | ${note ? noteLink(title, note) : linkLabel(title)} |`,
      );
    }
    lines.push("");
  }

  const moduleLine = (item: CanvasModuleItem): string => {
    const indent = "\t".repeat(Number(item.indent || 0));
    const title = item.title || item.type;
    if (item.type === "SubHeader") return `${indent}- **${title}**`;
    const target = planTarget(plan, item.type.toLowerCase(), item.type === "Page" ? item.page_url : item.content_id);
    if (target) return `${indent}- ${noteLink(title, target)}`;
    const url = item.external_url || item.html_url || item.url;
    const note = item.type === "File" ? " · Canvas only" : "";
    return url ? `${indent}- [${linkLabel(title)}](${url})${note}` : `${indent}- ${title}${note}`;
  };
  const modules = byPosition(data.modules);
  if (modules.length) {
    lines.push("## Modules", "");
    for (const module of modules) {
      const unlock = canvasDate(module.unlock_at);
      const locked =
        unlock && new Date(unlock).getTime() > Date.now() ? ` (unlocks ${displayDate(unlock, timezone)})` : "";
      lines.push(`### ${String(module.name).trim()}${locked}`, "");
      const items = byPosition(module.items || []);
      lines.push(...(items.length ? items.map(moduleLine) : ["_Empty_"]), "");
    }
  }

  const syllabus = markdown(data.course.syllabus_body, plan.note);
  if (syllabus.trim()) lines.push("## Syllabus", "", syllabus);
  return `${lines.join("\n").trimEnd()}\n`;
}

export async function writeHome(
  vaultDirectory: string,
  timezone: string,
  courses: Array<{ data: CourseData; plan: VaultPlan }>,
  syncedAt: string,
): Promise<void> {
  const lines = [`Last synced ${displayDate(syncedAt, timezone)}`, "", "## Courses", ""];
  for (const { data, plan } of courses)
    lines.push(`- ${noteLink(`${plan.code} · ${data.configuredCourse.name}`, `${plan.code}/${plan.note}`)}`);
  const upcoming = courses
    .flatMap(({ data, plan }) =>
      deadlineRows(courseTasks(data))
        .filter((row) => row.due && new Date(row.due).getTime() >= new Date(syncedAt).getTime())
        .map((row) => ({ ...row, plan })),
    )
    .sort((left, right) => new Date(left.due ?? 0).getTime() - new Date(right.due ?? 0).getTime());
  lines.push("", "## Upcoming", "");
  if (!upcoming.length) lines.push("Nothing due.");
  else {
    lines.push("| Due | Course | Task |", "|---|---|---|");
    for (const row of upcoming) {
      const note = taskNote(row.plan, row.task);
      const title = row.audience ? `${row.task.title} (${row.audience})` : row.task.title;
      lines.push(
        `| ${displayDate(row.due, timezone)} | ${row.plan.code} | ${note ? noteLink(title, `${row.plan.code}/${note}`) : linkLabel(title)} |`,
      );
    }
  }
  await writeSummary(
    path.join(vaultDirectory, "Home.md"),
    `${frontmatter({ type: "home" })}${lines.join("\n")}\n`,
    timezone,
  );
}
