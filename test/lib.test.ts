import assert from "node:assert/strict";
import test from "node:test";
import {
  byPosition,
  canvasDate,
  compareStates,
  documentRecord,
  htmlToMarkdown,
  localDateTime,
  preserveIncompleteState,
  safeName,
  stateFromDocuments,
  uniqueNames,
  vaultName,
  zonedDateTime,
  zonedInstant,
} from "../src/lib.ts";

test("HTML normalization preserves useful text and links", () => {
  assert.equal(
    htmlToMarkdown('<h2>Hello</h2><p>See <a href="https://example.com">resource</a>.</p>'),
    "## Hello\n\nSee [resource](https://example.com).\n",
  );
});

test("HTML normalization preserves Canvas images with sanitized verifier URLs", () => {
  const html =
    '<p><img src="https://canvas.nus.edu.sg/courses/94257/files/9680978/preview?verifier=<redacted>" alt="image.png" width="662" height="179" data-api-endpoint="https://canvas.nus.edu.sg/api/v1/courses/94257/files/9680978" data-api-returntype="File"></p>';
  assert.equal(
    htmlToMarkdown(html, (fileId) => `../files/${fileId}/downloaded image.png`),
    "![image.png](../files/9680978/downloaded%20image.png)\n",
  );
});

test("resolved Canvas links point at local vault paths", () => {
  assert.equal(
    htmlToMarkdown(
      '<p><a href="https://canvas.nus.edu.sg/courses/1/files/42?wrap=1">SOP</a> and <a href="https://example.com">site</a></p>',
      undefined,
      (href) => (href.includes("/files/42") ? "../Files/PE (1) SOP.pdf" : null),
    ),
    "[SOP](../Files/PE%20%281%29%20SOP.pdf) and [site](https://example.com)\n",
  );
});

test("safe file names remove path separators", () => {
  assert.equal(safeName("../Week 1: Intro.pdf"), "-Week 1- Intro.pdf");
});

test("vault names avoid Obsidian link syntax", () => {
  assert.equal(vaultName("Tutorial #3 [draft] ^x"), "Tutorial 3 (draft) -x");
});

test("duplicate names keep the lowest ID plain and number the rest", () => {
  const first = { id: 1, name: "Notes.pdf" };
  const second = { id: 2, name: "notes.pdf" };
  const third = { id: 3, name: "Slides.pdf" };
  const names = uniqueNames(
    [second, third, first],
    (item) => item.name,
    (item) => item.id,
  );
  assert.equal(names.get(first), "Notes.pdf");
  assert.equal(names.get(second), "notes (2).pdf");
  assert.equal(names.get(third), "Slides.pdf");
});

test("Canvas position ordering is stable", () => {
  assert.deepEqual(
    byPosition([
      { id: 1, position: 2 },
      { id: 2, position: null },
      { id: 3, position: 1 },
    ]).map((item) => item.id),
    [3, 1, 2],
  );
});

test("dates render in the course timezone and drop canvas-cli zero times", () => {
  assert.equal(canvasDate("0001-01-01T00:00:00Z"), null);
  assert.equal(localDateTime("2026-10-03T02:00:00Z"), "2026-10-03T10:00");
  assert.equal(zonedDateTime("2026-10-03T02:00:00Z"), "2026-10-03T10:00:00+08:00");
  assert.equal(zonedDateTime("0001-01-01T00:00:00Z"), null);
  assert.equal(zonedInstant("2026-10-03T10:00:05"), "2026-10-03T02:00:05.000Z");
  assert.equal(zonedInstant("2026-10-03T10:00:00+08:00"), "2026-10-03T10:00:00+08:00");
});

test("state comparison reports stable content changes", () => {
  const before = stateFromDocuments([
    documentRecord({ id: 1, kind: "page", course: "CS1", title: "A", content: "old" }),
  ]);
  const after = stateFromDocuments([
    documentRecord({ id: 1, kind: "page", course: "CS1", title: "A", content: "new" }),
  ]);
  const changes = compareStates(before, after);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.action, "modified");
  assert.deepEqual(
    changes[0]?.fields.map((field) => field.field),
    ["content_sha256"],
  );
});

test("incomplete resource collections do not report removals", () => {
  const before = stateFromDocuments([
    documentRecord({ id: 1, kind: "page", course: "CS1", title: "A", content: "old" }),
  ]);
  const preserved = preserveIncompleteState(before, {}, ["page"]);
  assert.deepEqual(preserved, before);
  assert.deepEqual(compareStates(before, preserved, ["page"]), []);
});
