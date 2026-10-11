#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assignmentDates,
  conversationBelongsToCourse,
  embeddedFileIds,
  inboxConversationOrder,
  inboxDetailArgs,
  inboxListArgs,
  inboxMarkdown,
  incompleteDocumentKinds,
  sanitizeCanvasSecrets,
} from "./archive-helpers.ts";
import { canvasDownload, canvasError, canvasJson, collectApiResource, collectResource } from "./canvas-client.ts";
import { collectCanvasTimestamps } from "./canvas-timestamps.ts";
import { classifyWarnings, pendingFromRun, renderReport } from "./changes.ts";
import { loadConfig, parseOptions } from "./config.ts";
import { historyReport, readHistory, recordHistory, reviewHistory, startHistory } from "./history.ts";
import {
  atomicWrite,
  canvasDate,
  compareStates,
  documentRecord,
  extractText,
  htmlToMarkdown,
  preserveIncompleteState,
  readJson,
  safeName,
  setFileMtime,
  sha256File,
  stableJson,
  stateFromDocuments,
  writeJson,
  zonedDateTime,
} from "./lib.ts";
import { courseTasks } from "./tasks.ts";
import type {
  ArchiveConfig,
  ArchiveDocument,
  ArchiveResult,
  ArchiveState,
  AssignmentOverride,
  CanvasAnnouncement,
  CanvasAssignment,
  CanvasAssignmentGroup,
  CanvasCalendarEvent,
  CanvasCourse,
  CanvasFile,
  CanvasFolder,
  CanvasInboxConversation,
  CanvasModule,
  CanvasModuleItem,
  CanvasPage,
  CanvasQuiz,
  CanvasWarning,
  ConfiguredCourse,
  CourseData,
  FileEntry,
  FileManifest,
  KnownContent,
  PendingChanges,
  SyncOptions,
} from "./types.ts";
import {
  planVault,
  taskNote,
  type VaultCourse,
  type VaultPlan,
  vaultPathForDocument,
  writeHome,
  writeVault,
} from "./vault.ts";

export {
  assignmentDates,
  conversationBelongsToCourse,
  embeddedFileIds,
  forwardedMessageContent,
  inboxConversationOrder,
  inboxDetailArgs,
  inboxListArgs,
  incompleteDocumentKinds,
  sanitizeCanvasSecrets,
} from "./archive-helpers.ts";
export { parseOptions } from "./config.ts";

const execFileAsync = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function moduleItems(modules: CanvasModule[]): CanvasModuleItem[] {
  return modules.flatMap((module) => module.items || []);
}

async function supplementPages(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  courseId: number,
  modules: CanvasModule[],
  listedPages: CanvasPage[],
  knownContent: KnownContent = {},
): Promise<CanvasPage[]> {
  const pagesByUrl = new Map(listedPages.map((page) => [page.url, page]));
  const pageUrls = new Set(
    moduleItems(modules)
      .map((item) => (item.type === "Page" ? item.page_url : undefined))
      .filter((pageUrl): pageUrl is string => Boolean(pageUrl)),
  );
  for (const pageUrl of knownContent.page_urls || []) pageUrls.add(pageUrl);
  for (const pageUrl of [...pageUrls].sort()) {
    if (pagesByUrl.has(pageUrl)) continue;
    const page = await collectResource<CanvasPage | null>(
      config,
      warnings,
      "page",
      ["pages", "get", pageUrl, "--course-id", String(courseId)],
      null,
      pageUrl,
    );
    if (page) pagesByUrl.set(page.url || pageUrl, page);
  }
  return [...pagesByUrl.values()].sort((left, right) => String(left.url).localeCompare(String(right.url)));
}

async function supplementFiles(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  resources: { modules: CanvasModule[] } & Record<string, unknown>,
  listedFiles: CanvasFile[],
  knownContent: KnownContent = {},
): Promise<CanvasFile[]> {
  const filesById = new Map(listedFiles.map((file) => [Number(file.id), file]));
  const fileIds = embeddedFileIds(resources);
  const knownFiles = new Map((knownContent.files || []).map((file) => [Number(file.id), file]));
  for (const fileId of knownFiles.keys()) fileIds.add(fileId);
  for (const item of moduleItems(resources.modules)) {
    if (item.type === "File" && item.content_id) fileIds.add(Number(item.content_id));
  }
  for (const fileId of [...fileIds].sort((left, right) => left - right)) {
    if (filesById.has(fileId)) continue;
    const file = await collectResource<CanvasFile | null>(
      config,
      warnings,
      "file",
      ["files", "get", String(fileId)],
      null,
      String(fileId),
    );
    if (file) filesById.set(Number(file.id || fileId), file);
    else {
      const knownFile = knownFiles.get(fileId);
      if (knownFile) filesById.set(fileId, { ...knownFile, _legacy_seed: true });
    }
  }
  return [...filesById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function supplementFolders(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  listedFolders: CanvasFolder[],
  files: CanvasFile[],
): Promise<CanvasFolder[]> {
  const foldersById = new Map(
    (listedFolders || []).filter((folder) => folder?.id != null).map((folder) => [Number(folder.id), folder]),
  );
  const pending = [
    ...new Set(
      [
        ...(files || []).map((file) => Number(file.folder_id)),
        ...(listedFolders || []).map((folder) => Number(folder.parent_folder_id)),
      ].filter((folderId) => Number.isFinite(folderId) && folderId > 0 && !foldersById.has(folderId)),
    ),
  ].sort((left, right) => left - right);

  for (let index = 0; index < pending.length; index += 1) {
    const folderId = pending[index];
    if (folderId === undefined) continue;
    if (foldersById.has(folderId)) continue;
    const result = await collectResource<CanvasFolder | CanvasFolder[] | null>(
      config,
      warnings,
      "folder",
      ["folders", "get", "--folder-id", String(folderId)],
      null,
      String(folderId),
    );
    const folder = Array.isArray(result) ? result[0] : result;
    if (!folder?.id) continue;
    foldersById.set(Number(folder.id), folder);
    const parentId = Number(folder.parent_folder_id);
    if (Number.isFinite(parentId) && parentId > 0 && !foldersById.has(parentId) && !pending.includes(parentId))
      pending.push(parentId);
  }
  return [...foldersById.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

async function collectInboxForCourse(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  courseId: number,
): Promise<{ summaries: CanvasInboxConversation[]; conversations: CanvasInboxConversation[] }> {
  const summaries = await collectApiResource<CanvasInboxConversation[]>(
    config,
    warnings,
    "inbox-list",
    inboxListArgs(courseId),
  );
  const conversations: CanvasInboxConversation[] = [];
  const seen = new Set<number>();
  for (const summary of summaries) {
    const id = Number(summary?.id);
    if (!Number.isFinite(id) || seen.has(id)) continue;
    seen.add(id);
    if (!conversationBelongsToCourse(summary, courseId)) {
      warnings.push({
        kind: "inbox-attribution",
        message: `Conversation ${id} returned for course_${courseId} identifies a different course; skipped.`,
      });
      continue;
    }
    const conversation = await collectApiResource<CanvasInboxConversation | null>(
      config,
      warnings,
      "inbox",
      inboxDetailArgs(id),
      null,
    );
    if (!conversation) continue;
    if (!conversationBelongsToCourse(conversation, courseId)) {
      warnings.push({
        kind: "inbox-attribution",
        message: `Conversation ${id} detail identifies a different course than course_${courseId}; skipped.`,
      });
      continue;
    }
    conversations.push(conversation);
  }
  conversations.sort(inboxConversationOrder);
  return { summaries, conversations };
}

async function collectCourse(config: ArchiveConfig, configuredCourse: ConfiguredCourse): Promise<CourseData> {
  const warnings: CanvasWarning[] = [];
  const courseId = configuredCourse.id;
  const course = await canvasJson<CanvasCourse>(config, ["courses", "get", String(courseId)]);
  const modules = await collectResource<CanvasModule[]>(config, warnings, "module", [
    "modules",
    "list",
    "--course-id",
    String(courseId),
    "--include",
    "items,content_details",
  ]);
  const listedPages = await collectResource<CanvasPage[]>(config, warnings, "page-list", [
    "pages",
    "list",
    "--course-id",
    String(courseId),
    "--include",
    "body",
  ]);
  const pages = await supplementPages(config, warnings, courseId, modules, listedPages, configuredCourse.knownContent);
  const assignmentGroups = await collectResource<CanvasAssignmentGroup[]>(config, warnings, "assignment-group-list", [
    "assignment-groups",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const assignments = await collectResource<CanvasAssignment[]>(config, warnings, "assignment-list", [
    "assignments",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const assignmentOverrides: Record<string, AssignmentOverride[]> = {};
  for (const assignment of assignments) {
    assignmentOverrides[assignment.id] = await collectResource<AssignmentOverride[]>(
      config,
      warnings,
      "assignment-override",
      ["overrides", "list", "--course-id", String(courseId), "--assignment-id", String(assignment.id)],
    );
  }
  // Canvas only lists the last 14 days of announcements unless given an explicit window.
  const announcementsUntil = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const listedAnnouncements = await collectResource<CanvasAnnouncement[]>(config, warnings, "announcement", [
    "announcements",
    "list",
    "--course-id",
    String(courseId),
    "--start-date",
    (canvasDate(course.created_at) ?? "2000-01-01").slice(0, 10),
    "--end-date",
    announcementsUntil,
  ]);
  const announcements = await collectCanvasTimestamps(
    config,
    warnings,
    courseId,
    "announcement",
    listedAnnouncements,
    await readJson<CanvasAnnouncement[]>(
      path.join(config.rawDirectory, configuredCourse.code, "announcements.json"),
      [],
    ),
  );
  const listedQuizzes = await collectResource<CanvasQuiz[]>(config, warnings, "quiz-list", [
    "quizzes",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const quizzes = await collectCanvasTimestamps(
    config,
    warnings,
    courseId,
    "quiz",
    listedQuizzes,
    await readJson<CanvasQuiz[]>(path.join(config.rawDirectory, configuredCourse.code, "quizzes.json"), []),
  );
  const calendarEvents = await collectResource<CanvasCalendarEvent[]>(config, warnings, "calendar", [
    "calendar",
    "list",
    "--course-id",
    String(courseId),
    "--all-events",
  ]);
  const inbox = await collectInboxForCourse(config, warnings, courseId);
  const listedFolders = await collectResource<CanvasFolder[]>(config, warnings, "file-list", [
    "folders",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const listedFiles = await collectResource<CanvasFile[]>(config, warnings, "file-list", [
    "files",
    "list",
    "--course-id",
    String(courseId),
  ]);
  const files = await supplementFiles(
    config,
    warnings,
    { course, modules, pages, assignments, announcements, quizzes, calendarEvents },
    listedFiles,
    configuredCourse.knownContent,
  );
  const folders = await supplementFolders(config, warnings, listedFolders, files);
  return sanitizeCanvasSecrets({
    configuredCourse,
    course,
    modules,
    pages,
    assignments,
    assignmentGroups,
    assignmentOverrides,
    announcements,
    files,
    folders,
    quizzes,
    calendarEvents,
    inboxList: inbox.summaries,
    inbox: inbox.conversations,
    warnings,
  });
}

async function existingFileMatches(filePath: string, size?: number): Promise<boolean> {
  try {
    return (await stat(filePath)).size === size;
  } catch {
    return false;
  }
}

async function unlinkArchivedPath(courseDirectory: string, relativePath?: string): Promise<boolean> {
  if (!relativePath) return false;
  try {
    await unlink(path.join(courseDirectory, relativePath));
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function cleanupGeneratedDocuments(
  courseDirectory: string,
  documents: ArchiveDocument[],
  incompleteKinds: string[],
): Promise<void> {
  const incomplete = new Set(incompleteKinds);
  for (const kind of ["page", "assignment", "announcement", "module", "quiz", "inbox"]) {
    if (incomplete.has(kind)) continue;
    const directory = path.join(courseDirectory, "content", kind === "inbox" ? "inbox" : `${kind}s`);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw error;
    }
    const expected = new Set(
      documents
        .filter((document) => document.kind === kind && document.local_path)
        .map((document) => path.basename(document.local_path)),
    );
    for (const name of names) {
      if (path.extname(name).toLocaleLowerCase("en") !== ".md" || expected.has(name)) continue;
      await unlink(path.join(directory, name));
    }
  }
}

async function archiveFiles(
  config: ArchiveConfig,
  data: CourseData,
  courseDirectory: string,
  options: SyncOptions,
): Promise<FileEntry[]> {
  const manifestPath = path.join(courseDirectory, "file-manifest.json");
  const previous = await readJson<FileManifest>(manifestPath, { files: {} });
  const fileListIncomplete = data.warnings.some((warning) => warning.kind === "file-list");
  const manifest: FileManifest = {
    course: data.configuredCourse.code,
    files: fileListIncomplete ? { ...(previous.files || {}) } : {},
  };
  const entries: FileEntry[] = [];
  for (const file of [...data.files].sort((left, right) => left.id - right.id)) {
    const displayName = file.display_name || file.filename || `file-${file.id}`;
    const relativePath = path.join("content", "files", String(file.id), safeName(displayName));
    const destination = path.join(courseDirectory, relativePath);
    const old = previous.files?.[file.id];
    const matches = await existingFileMatches(destination, file.size);
    let status = "metadata-only";
    let contentSha256 = old?.content_sha256 ?? "";
    let origin = old?.origin ?? "";
    let legacyPreserved = old?.legacy_preserved ?? null;
    const unchanged = matches && old?.updated_at === file.updated_at && old?.size === file.size;
    if (options.downloadFiles && file.size > config.maxFileBytes) status = "skipped-too-large";
    else if (options.downloadFiles && unchanged) status = origin ? "legacy-preserved" : "unchanged";
    else if (options.downloadFiles) {
      try {
        await canvasDownload(config, file.id, destination);
        status = "downloaded";
        contentSha256 = await sha256File(destination);
        origin = "";
      } catch (error) {
        status = "download-failed";
        const { raw, structured } = canvasError(error);
        const reason = structured ? `files.download: ${structured.error}` : (raw.split("\n")[0] ?? "Download failed");
        data.warnings.push({
          kind: "file",
          id: String(file.id),
          message: sanitizeCanvasSecrets(`${file.id} — ${displayName}: ${reason}`),
        });
      }
    }
    if (file.updated_at && ["downloaded", "unchanged", "legacy-preserved"].includes(status))
      await setFileMtime(destination, file.updated_at);
    if (options.downloadFiles && matches && !contentSha256) contentSha256 = await sha256File(destination);

    let text = old?.text ?? { status: "not-requested", bytes: 0 };
    const textRelativePath = path.join("content", "text", "files", String(file.id), `${safeName(displayName)}.txt`);
    if (options.extractText && (status === "downloaded" || status === "unchanged" || status === "legacy-preserved")) {
      const textDestination = path.join(courseDirectory, textRelativePath);
      if (status === "downloaded" || !(await existingFileMatches(textDestination, old?.text?.file_bytes))) {
        text = await extractText(destination, textDestination, {
          contentType: file["content-type"] || "",
          maxSourceBytes: config.maxTextSourceBytes,
          mtime: file.updated_at,
        });
        if (text.status === "extracted") text.file_bytes = (await stat(textDestination)).size;
      }
    }
    if (options.extractText && legacyPreserved?.local_path) {
      const preservedSource = path.join(courseDirectory, legacyPreserved.local_path);
      const preservedTextRelative = path.join(
        "content",
        "text",
        "legacy-preserved",
        `${file.id}-${safeName(displayName)}.txt`,
      );
      const preservedTextDestination = path.join(courseDirectory, preservedTextRelative);
      const previousText = legacyPreserved.text ?? { status: "not-requested", bytes: 0 };
      if (!(await existingFileMatches(preservedTextDestination, previousText.file_bytes))) {
        const extracted = await extractText(preservedSource, preservedTextDestination, {
          contentType: file["content-type"] || "",
          maxSourceBytes: config.maxTextSourceBytes,
          mtime: file.updated_at,
        });
        if (extracted.status === "extracted") extracted.file_bytes = (await stat(preservedTextDestination)).size;
        legacyPreserved = {
          ...legacyPreserved,
          text_path: extracted.status === "extracted" ? preservedTextRelative.split(path.sep).join("/") : "",
          text: extracted,
        };
      }
    }
    const entry: FileEntry = {
      canvas_id: file.id,
      name: displayName,
      size: file.size,
      updated_at: file.updated_at,
      content_type: file["content-type"] || "",
      source_url: file.url,
      local_path: relativePath.split(path.sep).join("/"),
      status,
      content_sha256: contentSha256,
      origin,
      legacy_preserved: legacyPreserved,
      text_path: text.status === "extracted" ? textRelativePath.split(path.sep).join("/") : "",
      text,
    };
    manifest.files[file.id] = entry;
    entries.push(entry);
    await writeJson(manifestPath, manifest);
  }
  if (!fileListIncomplete) {
    const currentIds = new Set(data.files.map((file) => String(file.id)));
    for (const [fileId, old] of Object.entries(previous.files || {})) {
      if (currentIds.has(String(fileId))) continue;
      for (const oldPath of [
        old.local_path,
        old.text_path,
        old.legacy_preserved?.local_path,
        old.legacy_preserved?.text_path,
      ])
        await unlinkArchivedPath(courseDirectory, oldPath);
    }
  }
  await writeJson(manifestPath, manifest);
  return entries;
}

async function buildDocuments(
  data: CourseData,
  courseDirectory: string,
  fileEntries: FileEntry[],
): Promise<ArchiveDocument[]> {
  const code = data.configuredCourse.code;
  const documents: ArchiveDocument[] = [];
  const filesById = new Map(fileEntries.map((file) => [Number(file.canvas_id), file]));
  const markdown = (html: unknown, localPath?: string): string =>
    htmlToMarkdown(html, (fileId, source) => {
      const file = fileId === null ? undefined : filesById.get(fileId);
      if (!file) return source;
      return localPath ? path.posix.relative(path.posix.dirname(localPath), file.local_path) : file.local_path;
    });
  documents.push(
    documentRecord({
      id: data.course.id,
      kind: "course",
      course: code,
      title: data.course.name,
      sourceUrl: `https://canvas.nus.edu.sg/courses/${data.course.id}`,
      metadata: {
        course_id: data.course.id,
        course_code: data.course.course_code,
        default_view: data.course.default_view,
      },
      content: markdown(data.course.syllabus_body || ""),
    }),
  );
  for (const page of data.pages) {
    const localPath = path.posix.join("content/pages", `${page.page_id || safeName(page.url)}.md`);
    const content = markdown(page.body || "", localPath);
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${page.title}\n\n${content}`,
      canvasDate(page.updated_at) ?? page.created_at,
    );
    documents.push(
      documentRecord({
        id: page.page_id || page.url,
        kind: "page",
        course: code,
        title: page.title,
        sourceUrl: page.html_url || `https://canvas.nus.edu.sg/courses/${data.course.id}/pages/${page.url}`,
        updatedAt: page.updated_at,
        localPath,
        metadata: { page_url: page.url, published: page.published, front_page: page.front_page },
        content,
      }),
    );
  }
  for (const assignment of data.assignments) {
    const dates = assignmentDates(assignment, data.assignmentOverrides[assignment.id]);
    const localPath = path.posix.join("content/assignments", `${assignment.id}.md`);
    const content = markdown(assignment.description || "", localPath);
    const dateLines = dates.map((date) => `- ${date.audience}: ${date.due_at || "no due date"}`).join("\n");
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${assignment.name}\n\n## Dates\n\n${dateLines || "- No dated variants"}\n\n${content}`,
      canvasDate(assignment.updated_at) ?? assignment.created_at,
    );
    documents.push(
      documentRecord({
        id: assignment.id,
        kind: "assignment",
        course: code,
        title: assignment.name,
        sourceUrl: assignment.html_url,
        updatedAt: assignment.updated_at,
        localPath,
        metadata: {
          dates,
          points_possible: assignment.points_possible,
          published: assignment.published,
          submission_types: assignment.submission_types || [],
          assignment_group_id: assignment.assignment_group_id,
        },
        content,
      }),
    );
  }
  const sortedAnnouncements = [...data.announcements].sort(
    (left, right) => new Date(left.posted_at || 0).getTime() - new Date(right.posted_at || 0).getTime(),
  );
  for (const announcement of sortedAnnouncements) {
    const localPath = path.posix.join("content/announcements", `${announcement.id}.md`);
    const content = markdown(announcement.message || "", localPath);
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${announcement.title}\n\n${content}`,
      announcement.updated_at || announcement.posted_at,
    );
    documents.push(
      documentRecord({
        id: announcement.id,
        kind: "announcement",
        course: code,
        title: announcement.title,
        sourceUrl: announcement.html_url,
        updatedAt: announcement.updated_at || announcement.posted_at,
        localPath,
        metadata: { posted_at: announcement.posted_at, published: announcement.published },
        content,
      }),
    );
  }
  for (const module of data.modules) {
    const lines = (module.items || []).map(
      (item) =>
        `${"  ".repeat(item.indent || 0)}- ${item.type}: ${item.title} ${item.html_url || item.external_url || ""}`,
    );
    const localPath = path.posix.join("content/modules", `${module.id}.md`);
    await atomicWrite(path.join(courseDirectory, localPath), `# ${module.name}\n\n${lines.join("\n")}\n`);
    documents.push(
      documentRecord({
        id: module.id,
        kind: "module",
        course: code,
        title: module.name,
        localPath,
        metadata: { position: module.position, published: module.published, unlock_at: module.unlock_at },
        content: lines.join("\n"),
      }),
    );
  }
  for (const quiz of data.quizzes) {
    const localPath = path.posix.join("content/quizzes", `${quiz.id}.md`);
    const content = markdown(quiz.description || "", localPath);
    const dateLines = [
      quiz.due_at ? `- Due: ${quiz.due_at}` : "",
      quiz.unlock_at ? `- Opens: ${quiz.unlock_at}` : "",
      quiz.lock_at ? `- Closes: ${quiz.lock_at}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${quiz.title}\n\n## Details\n\n${dateLines || "- No dated variants"}\n\n${content}`,
      canvasDate(quiz.updated_at) ?? quiz.created_at,
    );
    documents.push(
      documentRecord({
        id: quiz.id,
        kind: "quiz",
        course: code,
        title: quiz.title,
        sourceUrl: quiz.html_url,
        updatedAt: quiz.updated_at,
        localPath,
        metadata: {
          due_at: quiz.due_at,
          unlock_at: quiz.unlock_at,
          lock_at: quiz.lock_at,
          points_possible: quiz.points_possible,
          published: quiz.published,
        },
        content,
      }),
    );
  }
  for (const event of data.calendarEvents) {
    documents.push(
      documentRecord({
        id: event.id,
        kind: "calendar",
        course: code,
        title: event.title,
        sourceUrl: event.html_url,
        updatedAt: event.updated_at,
        metadata: {
          start_at: event.start_at,
          end_at: event.end_at,
          location_name: event.location_name,
          context_code: event.context_code,
        },
        content: markdown(event.description || ""),
      }),
    );
  }
  for (const conversation of data.inbox) {
    const localPath = path.posix.join("content/inbox", `${conversation.id}.md`);
    const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
    const content = inboxMarkdown(conversation, (html) => markdown(html, localPath));
    await atomicWrite(
      path.join(courseDirectory, localPath),
      `# ${conversation.subject || `Conversation ${conversation.id}`}\n\n${content}\n`,
      conversation.last_message_at || conversation.updated_at,
    );
    documents.push(
      documentRecord({
        id: conversation.id,
        kind: "inbox",
        course: code,
        title: conversation.subject || `Conversation ${conversation.id}`,
        sourceUrl:
          conversation.html_url || conversation.url || `https://canvas.nus.edu.sg/conversations/${conversation.id}`,
        updatedAt: conversation.last_message_at || conversation.updated_at,
        localPath,
        metadata: {
          conversation_id: conversation.id,
          course_id: data.course.id,
          workflow_state: conversation.workflow_state,
          last_message_at: conversation.last_message_at || conversation.updated_at,
          message_count: messages.length || conversation.message_count,
        },
        content,
      }),
    );
  }
  for (const file of fileEntries) {
    let searchableContent = "";
    for (const textPath of [file.text_path, file.legacy_preserved?.text_path].filter((value): value is string =>
      Boolean(value),
    )) {
      try {
        searchableContent += `${await readFile(path.join(courseDirectory, textPath), "utf8")}\n`;
      } catch {
        /* sidecar is optional */
      }
    }
    documents.push(
      documentRecord({
        id: file.canvas_id,
        kind: "file",
        course: code,
        title: file.name,
        sourceUrl: file.source_url,
        updatedAt: file.updated_at,
        localPath: file.local_path,
        metadata: {
          size: file.size,
          content_type: file.content_type,
          content_sha256: file.content_sha256,
          origin: file.origin,
          text_path: file.text_path,
          text_status: file.text.status,
          legacy_preserved: file.legacy_preserved,
        },
        content: searchableContent,
      }),
    );
  }
  return documents.sort((left, right) => left.document_id.localeCompare(right.document_id));
}

const rawKeys = [
  "course",
  "modules",
  "pages",
  "assignments",
  "assignmentGroups",
  "assignmentOverrides",
  "announcements",
  "files",
  "folders",
  "quizzes",
  "calendarEvents",
  "inboxList",
  "inbox",
  "warnings",
] as const satisfies ReadonlyArray<keyof CourseData>;

async function readDocuments(courseDirectory: string): Promise<Map<string, ArchiveDocument>> {
  const text = await readFile(path.join(courseDirectory, "documents.jsonl"), "utf8").catch(() => "");
  const documents = text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ArchiveDocument);
  return new Map(documents.map((document) => [document.document_id, document]));
}

async function archiveCourse(
  config: ArchiveConfig,
  data: CourseData,
  options: SyncOptions,
  checkpoint: (result: ArchiveResult) => Promise<void>,
): Promise<ArchiveResult> {
  const code = data.configuredCourse.code;
  const courseDirectory = path.join(config.rawDirectory, code);
  await mkdir(courseDirectory, { recursive: true });
  for (const key of rawKeys) await writeJson(path.join(courseDirectory, `${key}.json`), data[key]);
  const fileEntries = await archiveFiles(config, data, courseDirectory, options);
  await writeJson(path.join(courseDirectory, "warnings.json"), data.warnings);
  const statePath = path.join(courseDirectory, "state.json");
  const previousState = await readJson<ArchiveState>(statePath, {});
  const previousDocuments = await readDocuments(courseDirectory);
  const documents = await buildDocuments(data, courseDirectory, fileEntries);
  const jsonl = documents.map((document) => stableJson(document, 0)).join("\n");

  const currentState = stateFromDocuments(documents);
  const incompleteKinds = incompleteDocumentKinds(data.warnings);
  const state = preserveIncompleteState(previousState, currentState, incompleteKinds);
  const changes = compareStates(previousState, state, incompleteKinds);
  const result = {
    code,
    data,
    documents,
    previous: { documents: previousDocuments, state: previousState },
    fileEntries,
    changes,
    baseline: Object.keys(previousState).length === 0,
  };
  // Retain transitions before replacing the baseline, even if a later course or vault write fails.
  await checkpoint(result);
  await atomicWrite(path.join(courseDirectory, "documents.jsonl"), `${jsonl}${jsonl ? "\n" : ""}`);
  for (const change of changes.filter((change) => change.action === "removed")) {
    await unlinkArchivedPath(courseDirectory, previousState[change.document_id]?.local_path);
  }
  await cleanupGeneratedDocuments(courseDirectory, documents, incompleteKinds);
  await writeJson(statePath, state);
  return result;
}

interface ArchivedCourse extends VaultCourse {
  documents: ArchiveDocument[];
}

async function loadArchivedCourse(
  config: ArchiveConfig,
  configuredCourse: ConfiguredCourse,
): Promise<ArchivedCourse | null> {
  const rawDirectory = path.join(config.rawDirectory, configuredCourse.code);
  const read = <T>(name: string, fallback: T): Promise<T> =>
    readJson(path.join(rawDirectory, `${name}.json`), fallback);
  const course = await read<CanvasCourse | null>("course", null);
  if (!course) return null;
  const data: CourseData = {
    configuredCourse,
    course,
    modules: await read<CanvasModule[]>("modules", []),
    pages: await read<CanvasPage[]>("pages", []),
    assignments: await read<CanvasAssignment[]>("assignments", []),
    assignmentGroups: await read<CanvasAssignmentGroup[]>("assignmentGroups", []),
    assignmentOverrides: await read<Record<string, AssignmentOverride[]>>("assignmentOverrides", {}),
    announcements: await read<CanvasAnnouncement[]>("announcements", []),
    files: await read<CanvasFile[]>("files", []),
    folders: await read<CanvasFolder[]>("folders", []),
    quizzes: await read<CanvasQuiz[]>("quizzes", []),
    calendarEvents: await read<CanvasCalendarEvent[]>("calendarEvents", []),
    inboxList: await read<CanvasInboxConversation[]>("inboxList", []),
    inbox: await read<CanvasInboxConversation[]>("inbox", []),
    warnings: await read<CanvasWarning[]>("warnings", []),
  };
  const manifest = await read<FileManifest>("file-manifest", { files: {} });
  return {
    data,
    fileEntries: Object.values(manifest.files || {}),
    rawDirectory,
    documents: [...(await readDocuments(rawDirectory)).values()],
  };
}

async function loadArchive(config: ArchiveConfig): Promise<ArchivedCourse[]> {
  const courses: ArchivedCourse[] = [];
  for (const configuredCourse of config.courses) {
    const course = await loadArchivedCourse(config, configuredCourse);
    if (course) courses.push(course);
  }
  return courses;
}

const pendingPath = (config: ArchiveConfig) => path.join(config.rawDirectory, "unseen-changes.json");

async function readPending(config: ArchiveConfig): Promise<PendingChanges> {
  return readJson<PendingChanges>(pendingPath(config), { since: null, last_sync: null, first_syncs: [], changes: [] });
}

async function buildVault(
  config: ArchiveConfig,
  courses: ArchivedCourse[],
  syncedAt: string,
): Promise<Map<string, VaultPlan>> {
  const plans = new Map<string, VaultPlan>();
  const home: Array<{ data: CourseData; plan: VaultPlan }> = [];
  for (const course of courses) {
    const plan = planVault(course, config.timezone);
    await writeVault(config.vaultDirectory, config.timezone, course, plan);
    plans.set(plan.code, plan);
    home.push({ data: course.data, plan });
  }
  await writeHome(config.vaultDirectory, config.timezone, home, syncedAt);
  return plans;
}

function report(config: ArchiveConfig, pending: PendingChanges, courses: ArchivedCourse[]): string {
  return renderReport(
    pending,
    courses.map((course) => ({
      code: course.data.configuredCourse.code,
      name: course.data.configuredCourse.name,
      coverage: classifyWarnings(course.data),
    })),
    config.timezone,
  );
}

async function fetchCanvas(config: ArchiveConfig, argv: string[]): Promise<void> {
  const options = parseOptions(config, argv);
  const existing = await readHistory(config.rawDirectory);
  const baselines = new Set(existing?.runs.flatMap((run) => run.first_syncs) ?? []);
  await startHistory(config.rawDirectory, new Date().toISOString());
  for (const course of options.courses) {
    console.error(`[${course.code}] collecting Canvas metadata`);
    const data = await collectCourse(config, course);
    console.error(`[${course.code}] downloading/indexing ${data.files.length} files`);
    await archiveCourse(config, data, options, async (result) => {
      const plan = planVault({ ...result, rawDirectory: path.join(config.rawDirectory, result.code) }, config.timezone);
      const observed = new Date().toISOString();
      const baseline = result.baseline || !baselines.has(result.code);
      await recordHistory(config.rawDirectory, {
        since: null,
        last_sync: observed,
        first_syncs: baseline ? [result.code] : [],
        changes: baseline
          ? []
          : pendingFromRun(
              result.changes,
              result.previous,
              new Map(result.documents.map((document) => [document.document_id, document])),
              (id, metadata) => vaultPathForDocument(plan, id, metadata),
            ).map((change) => ({ ...change, observed_at: observed })),
        courses: [
          { code: result.code, name: result.data.configuredCourse.name, coverage: classifyWarnings(result.data) },
        ],
      });
    });
  }
  const courses = await loadArchive(config);
  const syncedAt = new Date().toISOString();
  await buildVault(config, courses, syncedAt);

  await recordHistory(config.rawDirectory, {
    since: null,
    last_sync: syncedAt,
    completed: true,
    first_syncs: [],
    changes: [],
    courses: courses.map((course) => ({
      code: course.data.configuredCourse.code,
      name: course.data.configuredCourse.name,
      coverage: classifyWarnings(course.data),
    })),
  });
  const history = await readHistory(config.rawDirectory);
  if (!history) throw new Error("Fetch history was not recorded");
  const selected = historyReport(history);
  const next: PendingChanges = {
    since: selected.since,
    last_sync: selected.last_sync,
    first_syncs: selected.first_syncs,
    changes: selected.changes,
  };
  await writeJson(pendingPath(config), next);
  console.log(report(config, next, courses));
}

async function changes(config: ArchiveConfig, argv: string[]): Promise<void> {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--reviewed") continue;
    if (["--since", "--through"].includes(argv[i] ?? "") && argv[i + 1] && !argv[i + 1]?.startsWith("--")) {
      i += 1;
      continue;
    }
    throw new Error(`Unknown or incomplete report option: ${argv[i]}`);
  }
  const since = argv.includes("--since") ? argv[argv.indexOf("--since") + 1] : undefined;
  const through = argv.includes("--through") ? argv[argv.indexOf("--through") + 1] : undefined;
  const history = await readHistory(config.rawDirectory);
  const pending = await readPending(config);
  if (argv.includes("--reviewed")) {
    if (!through) throw new Error("Marking a report reviewed requires --through <last_sync>");
    if (since) throw new Error("--since selects a report; acknowledge it separately with --reviewed --through");
    if (history) await reviewHistory(config.rawDirectory, through);
    else if (through !== pending.last_sync)
      throw new Error("Canvas was fetched after that report; reprint it with `bun run changes` first");
    await writeJson(pendingPath(config), {
      since: through,
      last_sync: pending.last_sync,
      first_syncs: [],
      changes: [],
    } satisfies PendingChanges);
    console.log(`Marked changes through ${through} as reviewed; retained history is unchanged.`);
    return;
  }
  if (history) {
    const selected = historyReport(history, since, through);
    console.log(renderReport(selected, selected.courses, config.timezone));
    if (!selected.completed)
      console.log("The latest fetch did not complete; only recorded course collections are covered.");
  } else {
    if (since || through)
      throw new Error("Selectable reporting is unavailable until the first fetch records change history");
    console.log(report(config, pending, await loadArchive(config)));
    console.log("Only legacy unreviewed differences are available; timestamped change history has not started.");
  }
}

async function tasks(config: ArchiveConfig): Promise<void> {
  const zoned = (value: unknown) => zonedDateTime(value, config.timezone);
  const courses = (await loadArchive(config)).map((course) => {
    const plan = planVault(course, config.timezone);
    return {
      code: plan.code,
      name: course.data.configuredCourse.name,
      tasks: courseTasks(course.data).map((task) => {
        const note = taskNote(plan, task);
        return {
          ...task,
          due_at: zoned(task.due_at),
          unlock_at: zoned(task.unlock_at),
          lock_at: zoned(task.lock_at),
          overrides: task.overrides.map((override) => ({
            audience: override.audience,
            due_at: zoned(override.due_at),
            unlock_at: zoned(override.unlock_at),
            lock_at: zoned(override.lock_at),
          })),
          note: note ? path.join(config.vaultDirectory, plan.code, note) : null,
        };
      }),
    };
  });
  console.log(stableJson({ last_sync: zoned((await readPending(config)).last_sync), courses }));
}

async function doctor(config: ArchiveConfig): Promise<void> {
  const { stdout: version } = await execFileAsync(config.canvasBinary, ["version"]);
  const { stdout: auth } = await execFileAsync(config.canvasBinary, ["auth", "status"]);
  console.log(version.trim());
  console.log(auth.trim());
  console.log(`Raw directory: ${config.rawDirectory}`);
  console.log(`Vault: ${config.vaultDirectory}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const config = await loadConfig(projectDirectory);
  const [command = "fetch", ...options] = argv;
  if (command === "doctor") await doctor(config);
  else if (command === "fetch") await fetchCanvas(config, options);
  else if (command === "vault")
    await buildVault(
      config,
      await loadArchive(config),
      (await readPending(config)).last_sync ?? new Date().toISOString(),
    );
  else if (command === "changes") await changes(config, options);
  else if (command === "tasks") await tasks(config);
  else throw new Error(`Unknown command: ${command}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
