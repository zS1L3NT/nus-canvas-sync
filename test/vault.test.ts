import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyWarnings, describeChange, lineDiff, mergePending } from "../src/changes.ts";
import { documentRecord } from "../src/lib.ts";
import { courseTasks } from "../src/tasks.ts";
import type { CourseData, FileEntry, PendingChange } from "../src/types.ts";
import { planVault, vaultPathForDocument, writeHome, writeVault } from "../src/vault.ts";

function course(overrides: Partial<CourseData> = {}): CourseData {
  return {
    configuredCourse: { code: "CS1", id: 1, name: "Course", knownContent: {} },
    course: { id: 1, name: "Course One" },
    modules: [],
    pages: [],
    assignments: [],
    assignmentGroups: [],
    assignmentOverrides: {},
    announcements: [],
    files: [],
    folders: [],
    quizzes: [],
    calendarEvents: [],
    inboxList: [],
    inbox: [],
    warnings: [],
    ...overrides,
  };
}

function fileEntry(id: number, name: string, status = "downloaded"): FileEntry {
  return {
    canvas_id: id,
    name,
    size: 4,
    content_type: "application/pdf",
    local_path: `content/files/${id}/${name}`,
    status,
    content_sha256: "hash",
    origin: "",
    legacy_preserved: null,
    text_path: "",
    text: { status: "not-requested", bytes: 0 },
  };
}

test("vault repairs quiz modification dates and falls back to Canvas creation dates", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-vault-dates-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const created = "2026-07-02T09:09:45+08:00";
  const updated = "2026-09-01T10:00:00+08:00";
  const data = course({
    quizzes: [
      { id: 1, title: "Quiz", created_at: created, updated_at: updated },
      { id: 2, title: "Creation only", created_at: created, updated_at: "0001-01-01T00:00:00Z" },
    ],
    pages: [{ url: "page", title: "Page", body: "Content", created_at: created }],
    assignments: [{ id: 3, name: "Assignment", assignment_group_id: 1, created_at: created }],
    announcements: [{ id: 4, title: "Announcement", created_at: created, posted_at: updated }],
  });
  const vault = path.join(root, "vault");
  const archived = { data, rawDirectory: path.join(root, "raw"), fileEntries: [] };
  const plan = planVault(archived, "Asia/Singapore");
  await writeVault(vault, "Asia/Singapore", archived, plan);
  const quiz = path.join(vault, "CS1", plan.quizzes.get(1) ?? "");
  const content = await readFile(quiz, "utf8");
  await utimes(quiz, new Date(), new Date());
  await writeVault(vault, "Asia/Singapore", archived, plan);
  assert.equal((await stat(quiz)).mtimeMs, Date.parse(updated));
  assert.equal(await readFile(quiz, "utf8"), content);
  assert.match(content, /\ncreated: 2026-07-02T09:09:45\nupdated: 2026-09-01T10:00:00\n---\n/);
  for (const note of [
    plan.quizzes.get(2),
    plan.pages.get("page"),
    plan.assignments.get(3),
    plan.announcements.get(4),
  ]) {
    assert.ok(note);
    assert.equal((await stat(path.join(vault, "CS1", note))).mtimeMs, Date.parse(created));
    assert.match(
      await readFile(path.join(vault, "CS1", note), "utf8"),
      /\ncreated: 2026-07-02T09:09:45\nupdated: 2026-07-02T09:09:45\n---\n/,
    );
  }
});

test("adding date properties to a legacy Home note preserves its modification date", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-home-dates-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const syncedAt = "2026-09-01T02:00:00Z";
  await writeHome(root, "Asia/Singapore", [], syncedAt);
  const note = path.join(root, "Home.md");
  const body = (await readFile(note, "utf8")).replace(/^---\n[\s\S]*?\n---\n\n/, "");
  await writeFile(note, body);
  await utimes(note, new Date(syncedAt), new Date(syncedAt));
  await writeHome(root, "Asia/Singapore", [], syncedAt);
  assert.equal((await stat(note)).mtimeMs, Date.parse(syncedAt));
  assert.match(await readFile(note, "utf8"), /^---\ntype: "home"\ncreated: \S+\nupdated: 2026-09-01T10:00:00\n---\n/);
});

test("all source notes contain dates, unknown creation dates stay blank, and summaries keep stable dates", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-all-note-dates-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const created = "2026-07-02T01:09:45Z";
  const updated = "2026-09-01T02:00:00Z";
  const data = course({
    quizzes: [{ id: 1, title: "Unknown" }],
    announcements: [
      { id: 2, title: "Announcement", created_at: created, updated_at: updated },
      { id: 4, title: "Publication only", posted_at: updated },
    ],
    inbox: [{ id: 3, subject: "Message", last_message_at: updated, messages: [{ created_at: created, body: "Text" }] }],
  });
  const vault = path.join(root, "vault");
  const archived = { data, rawDirectory: path.join(root, "raw"), fileEntries: [] };
  const plan = planVault(archived, "Asia/Singapore");
  const render = async () => {
    await writeVault(vault, "Asia/Singapore", archived, plan);
    await writeHome(vault, "Asia/Singapore", [{ data, plan }], updated);
  };
  await render();
  const unknown = await readFile(path.join(vault, "CS1", plan.quizzes.get(1) ?? ""), "utf8");
  assert.match(unknown, /\ncreated:\nupdated:\n---\n/);
  assert.match(
    await readFile(path.join(vault, "CS1", plan.announcements.get(4) ?? ""), "utf8"),
    /\ncreated:\nupdated:\n---\n/,
  );
  for (const note of [plan.announcements.get(2), plan.inbox.get(3)]) {
    assert.ok(note);
    const text = await readFile(path.join(vault, "CS1", note), "utf8");
    assert.match(text, /\ncreated: 2026-07-02T09:09:45\nupdated: 2026-09-01T10:00:00\n---\n/);
    assert.equal((text.match(/^updated:/gm) ?? []).length, 1);
  }
  const summaries = [path.join(vault, "CS1", plan.note), path.join(vault, "Home.md")];
  const before = await Promise.all(
    summaries.map(async (note) => ({ text: await readFile(note, "utf8"), stat: await stat(note) })),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  await render();
  for (const [index, note] of summaries.entries()) {
    assert.match(before[index]?.text ?? "", /\ncreated: [\d-]+T[\d:]+\nupdated: [\d-]+T[\d:]+\n---\n/);
    assert.equal(await readFile(note, "utf8"), before[index]?.text);
    assert.equal((await stat(note)).mtimeMs, before[index]?.stat.mtimeMs);
  }
  await writeFile(summaries[0] ?? "", before[0]?.text.replace(/^updated:.*$/m, "updated: 2026-01-01T00:00:00") ?? "");
  data.course.syllabus_body = "<p>New content</p>";
  await render();
  const changed = await readFile(summaries[0] ?? "", "utf8");
  assert.equal(changed.match(/^created:.*$/m)?.[0], before[0]?.text.match(/^created:.*$/m)?.[0]);
  assert.notEqual(changed.match(/^updated:.*$/m)?.[0], "updated: 2026-01-01T00:00:00");
});

test("classic quizzes merge with their assignment and keep its overrides", () => {
  const data = course({
    quizzes: [{ id: 5, title: "Quiz 1", due_at: "0001-01-01T00:00:00Z" }],
    assignments: [
      { id: 50, name: "Quiz 1", assignment_group_id: 1, quiz_id: 5 },
      { id: 60, name: "Essay", assignment_group_id: 1, due_at: "2026-10-03T02:00:00Z" },
    ],
    assignmentOverrides: { 50: [{ id: 9, title: "L06", due_at: "2026-10-01T02:00:00Z" }] },
  });
  const tasks = courseTasks(data);
  assert.deepEqual(
    tasks.map((task) => [task.kind, task.id, task.assignment_id, task.due_at]),
    [
      ["quiz", 5, 50, null],
      ["assignment", 60, 60, "2026-10-03T02:00:00Z"],
    ],
  );
  assert.equal(tasks[0]?.overrides[0]?.audience, "L06");
});

test("vault plan uses clean names, Canvas folders and stable duplicates", () => {
  const data = course({
    folders: [
      { id: 1, name: "course files" },
      { id: 2, name: "Lecture #1", parent_folder_id: 1 },
    ],
    files: [
      { id: 10, folder_id: 2, size: 4 },
      { id: 11, folder_id: 2, size: 4 },
      { id: 12, folder_id: 99, size: 4 },
      { id: 13, folder_id: 2, size: 4, hidden_for_user: true },
    ],
    announcements: [{ id: 7, title: "Week 1", posted_at: "2026-08-10T16:30:00Z" }],
    assignments: [{ id: 3, name: "PE1", assignment_group_id: 1 }],
  });
  const plan = planVault(
    {
      data,
      rawDirectory: "/raw",
      fileEntries: [
        fileEntry(11, "slides.pdf"),
        fileEntry(10, "Slides.pdf"),
        fileEntry(12, "ps.pdf"),
        fileEntry(13, "image.png"),
        fileEntry(14, "gated.pdf", "download-failed"),
      ],
    },
    "Asia/Singapore",
  );
  assert.equal(plan.files.get(10), "Files/Lecture 1/Slides.pdf");
  assert.equal(plan.files.get(11), "Files/Lecture 1/slides (2).pdf");
  assert.equal(plan.files.get(12), "Files/ps.pdf");
  assert.equal(plan.files.get(13), "Attachments/image.png");
  assert.equal(plan.files.has(14), false);
  assert.equal(plan.announcements.get(7), "Announcements/2026-08-11 Week 1.md");
  assert.equal(vaultPathForDocument(plan, "CS1:assignment:3"), "CS1/Assignments/PE1.md");
});

test("vault notes link Canvas content to local files and drop stale generated files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "canvas-vault-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const rawDirectory = path.join(root, "raw");
  const vault = path.join(root, "vault");
  await mkdir(path.join(rawDirectory, "content/files/10"), { recursive: true });
  await writeFile(path.join(rawDirectory, "content/files/10/SOP.pdf"), "%PDF");
  const data = course({
    files: [{ id: 10, size: 4 }],
    assignments: [
      {
        id: 3,
        name: "PE1",
        assignment_group_id: 1,
        due_at: "2026-10-03T02:00:00Z",
        description: '<p>Read the <a href="https://canvas.nus.edu.sg/courses/1/files/10?wrap=1">SOP</a>.</p>',
      },
    ],
    modules: [{ id: 1, name: "Week 1", items: [{ id: 1, type: "Assignment", title: "PE1", content_id: 3 }] }],
  });
  const vaultCourse = { data, rawDirectory, fileEntries: [fileEntry(10, "SOP.pdf")] };
  await writeVault(vault, "Asia/Singapore", vaultCourse, planVault(vaultCourse, "Asia/Singapore"));

  const note = await readFile(path.join(vault, "CS1/Assignments/PE1.md"), "utf8");
  assert.match(note, /^---\ncourse: "\[\[CS1\/CS1\|CS1\]\]"\ntype: "assignment"\ndue: 2026-10-03T10:00\n/);
  assert.match(note, /\[SOP\]\(\.\.\/Files\/SOP\.pdf\)/);
  assert.equal(await readFile(path.join(vault, "CS1/Files/SOP.pdf"), "utf8"), "%PDF");
  const courseNote = await readFile(path.join(vault, "CS1/CS1.md"), "utf8");
  assert.match(courseNote, /### Week 1\n\n- \[PE1\]\(Assignments\/PE1\.md\)/);
  assert.match(courseNote, /\| Sat, 3 Oct 2026(?: at |, )10:00 (?:AM|am) \| \[PE1\]\(Assignments\/PE1\.md\) \|/);

  data.assignments = [];
  data.modules = [];
  await writeVault(vault, "Asia/Singapore", vaultCourse, planVault(vaultCourse, "Asia/Singapore"));
  await assert.rejects(readFile(path.join(vault, "CS1/Assignments/PE1.md")));
});

function change(action: PendingChange["action"], before: string | null, after: string | null): PendingChange {
  const snapshot = (content: string) => {
    const document = documentRecord({ id: 1, kind: "page", course: "CS1", title: "Page", content });
    return { title: document.title, metadata: {}, content, content_sha256: document.content_sha256 };
  };
  return {
    action,
    document_id: "CS1:page:1",
    course: "CS1",
    kind: "page",
    title: "Page",
    vault_path: "",
    before: before === null ? null : snapshot(before),
    after: after === null ? null : snapshot(after),
  };
}

test("unseen changes compare against the last reviewed state", () => {
  const timezone = "Asia/Singapore";
  assert.deepEqual(mergePending([change("added", null, "a")], [change("removed", "a", null)], timezone), []);
  assert.deepEqual(mergePending([change("modified", "a", "b")], [change("modified", "b", "a")], timezone), []);
  const merged = mergePending([change("added", null, "a")], [change("modified", "a", "b")], timezone);
  assert.equal(merged[0]?.action, "added");
  assert.equal(merged[0]?.after?.content, "b");
});

test("modified content is described as a line diff and date changes are readable", () => {
  assert.deepEqual(lineDiff("one\ntwo\nthree", "one\n2\nthree\nfour"), ["+ 2", "- two", "+ four"]);
  const quiz: PendingChange = {
    ...change("modified", "same", "same"),
    kind: "quiz",
    before: { title: "Quiz", metadata: { due_at: "2026-10-03T02:00:00Z" }, content: "", content_sha256: "x" },
    after: { title: "Quiz", metadata: { due_at: "2026-10-04T02:00:00Z" }, content: "", content_sha256: "x" },
  };
  const details = describeChange(quiz, "Asia/Singapore");
  assert.equal(details.length, 1);
  assert.match(
    details[0] ?? "",
    /^due: Sat, 3 Oct 2026(?: at |, )10:00 (?:AM|am) → Sun, 4 Oct 2026(?: at |, )10:00 (?:AM|am)$/,
  );
});

test("expected Canvas warnings become coverage notes with file names", () => {
  const coverage = classifyWarnings(
    course({
      warnings: [
        { kind: "page-list", message: "pages.list: Not found: the requested resource does not exist" },
        { kind: "folder", id: "4", message: "folders.get: user not authorised to perform that action" },
        { kind: "file", id: "9", message: "9 — ps-06.pdf: files.download: file has no download URL" },
        { kind: "file", id: "8", message: "files.get: The specified resource does not exist." },
        { kind: "file", id: "8", message: "8 — notes.pdf: files.download: The specified resource does not exist." },
        { kind: "assignment-list", message: "assignments.list: timeout" },
      ],
      files: [{ id: 8, display_name: "notes.pdf", size: 1 }],
      pages: [{ url: "week-1", title: "Week 1", body: '<a href="/courses/1/files/8">notes</a>' }],
    }),
  );
  assert.deepEqual(coverage.notes, [
    "The Pages list is unavailable; pages linked from modules are still archived.",
    "The Files tab is restricted; files linked from modules and pages are still archived.",
    "Not released yet, retried every fetch: ps-06.pdf",
    "Linked but no longer on Canvas: notes.pdf (in Week 1)",
  ]);
  assert.deepEqual(
    coverage.warnings.map((warning) => warning.kind),
    ["assignment-list"],
  );
});
