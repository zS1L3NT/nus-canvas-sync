import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCanvasTimestamps } from "../src/canvas-timestamps.ts";
import type { ArchiveConfig, CanvasQuiz, CanvasWarning } from "../src/types.ts";

const created = "2026-07-02T09:09:45+08:00";
const updated = "2026-09-01T10:00:00+08:00";

function response(nodes: unknown[], hasNextPage = false, endCursor: string | null = null) {
  return { data: { course: { records: { nodes, pageInfo: { hasNextPage, endCursor } } } } };
}

async function fixture(responses: unknown[], action: (config: ArchiveConfig, commands: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-quiz-dates-"));
  try {
    const binary = path.join(directory, "canvas");
    const commands = path.join(directory, "commands.jsonl");
    await writeFile(
      binary,
      `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const commands = ${JSON.stringify(commands)};
const index = existsSync(commands) ? readFileSync(commands, "utf8").trim().split("\\n").length : 0;
appendFileSync(commands, JSON.stringify(process.argv.slice(2)) + "\\n");
console.log(JSON.stringify({ body: ${JSON.stringify(responses)}[index], status_code: 200 }));
`,
      { mode: 0o755 },
    );
    await action({ canvasBinary: binary, canvasInstance: "https://canvas.example" } as ArchiveConfig, commands);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("quiz dates come from read-only GraphQL queries, matched by ID across pages", async () => {
  await fixture(
    [
      response([{ _id: "9", createdAt: created, updatedAt: updated }], true, 'cursor"\\'),
      response([
        { _id: "2", createdAt: created, updatedAt: updated },
        { _id: "1", createdAt: created, updatedAt: created },
      ]),
    ],
    async (config, commands) => {
      const quizzes: CanvasQuiz[] = [
        { id: 1, title: "Same title" },
        { id: 2, title: "Same title" },
      ];
      const warnings: CanvasWarning[] = [];
      assert.deepEqual(await collectCanvasTimestamps(config, warnings, 3, "quiz", quizzes), [
        { ...quizzes[0], created_at: created, updated_at: created },
        { ...quizzes[1], created_at: created, updated_at: updated },
      ]);
      assert.deepEqual(warnings, []);
      assert.equal(quizzes[0]?.updated_at, undefined);
      const calls = (await readFile(commands, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      assert.equal(calls.length, 2);
      for (const args of calls) {
        assert.deepEqual(args.slice(0, 3), ["api", "POST", "/api/graphql"]);
        assert.ok(args.includes("--no-cache"));
        const payload = JSON.parse(args[args.indexOf("--data") + 1] ?? "");
        assert.match(payload.query, /^query /);
        assert.doesNotMatch(payload.query, /submissions|grades|mutation/);
      }
      assert.deepEqual(JSON.parse(calls[1]?.[4] ?? "").variables, { courseId: "3", after: 'cursor"\\' });
    },
  );
});

test("GraphQL errors preserve previously collected dates and remain visible as warnings", async () => {
  await fixture([{ errors: [{ message: "Not authorized" }] }], async (config) => {
    const warnings: CanvasWarning[] = [];
    const previous = [{ id: 1, title: "Old", created_at: created, updated_at: updated }];
    assert.deepEqual(
      await collectCanvasTimestamps(config, warnings, 3, "quiz", [{ id: 1, title: "Current" }], previous),
      [{ ...previous[0], title: "Current" }],
    );
    assert.equal(warnings[0]?.kind, "quiz-timestamps");
    assert.match(warnings[0]?.message ?? "", /Not authorized/);
  });
});

test("a failed later page never applies partial timestamps", async () => {
  await fixture(
    [
      response([{ _id: "1", createdAt: created, updatedAt: updated }], true, "next"),
      { errors: [{ message: "Failed" }] },
    ],
    async (config) => {
      const warnings: CanvasWarning[] = [];
      assert.deepEqual(await collectCanvasTimestamps(config, warnings, 3, "quiz", [{ id: 1, title: "Quiz" }]), [
        { id: 1, title: "Quiz" },
      ]);
      assert.equal(warnings.length, 1);
    },
  );
});

test("missing quizzes and invalid dates produce coverage warnings without inventing dates", async () => {
  await fixture([response([{ _id: "1", createdAt: created, updatedAt: "0001-01-01T00:00:00Z" }])], async (config) => {
    const warnings: CanvasWarning[] = [];
    const dates = await collectCanvasTimestamps(config, warnings, 3, "quiz", [
      { id: 1, title: "One" },
      { id: 2, title: "Two" },
    ]);
    assert.equal(dates[0]?.created_at, created);
    assert.equal(dates[0]?.updated_at, undefined);
    assert.equal(dates[1]?.created_at, undefined);
    assert.deepEqual(
      warnings.map((warning) => warning.id),
      ["1", "2"],
    );
  });
});

test("broken pagination stops with a warning instead of looping", async () => {
  await fixture([response([], true, null)], async (config) => {
    const warnings: CanvasWarning[] = [];
    await collectCanvasTimestamps(config, warnings, 3, "quiz", [{ id: 1, title: "One" }]);
    assert.match(warnings[0]?.message ?? "", /cursor/i);
  });
});
