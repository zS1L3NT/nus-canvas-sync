import type { ArchiveChange, ArchiveDocument, ArchiveState, DocumentInput } from "../types.ts";
import { sha256, stableJson, stableValue } from "./serialization.ts";

export function formatDate(value: unknown, timezone = "Asia/Singapore"): string {
  if (!value) return "";
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

// canvas-cli reports a missing date as Go's zero time.
export function canvasDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1900 ? null : String(value);
}

export function displayDate(value: unknown, timezone = "Asia/Singapore"): string {
  const valid = canvasDate(value);
  if (!valid) return "";
  const date = new Date(valid);
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

// "2026-10-03T10:00" in the course timezone, the datetime format Obsidian properties expect.
export function localDateTime(value: unknown, timezone = "Asia/Singapore"): string {
  const valid = canvasDate(value);
  if (!valid) return "";
  const date = new Date(valid);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(date)
    .replace(" ", "T");
}

export function zonedDateTime(value: unknown, timezone = "Asia/Singapore"): string | null {
  const local = localDateTime(value, timezone);
  if (!local) return null;
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
    .formatToParts(new Date(String(value)))
    .find((part) => part.type === "timeZoneName")
    ?.value.replace("GMT", "");
  return `${local}:00${offset || "+00:00"}`;
}

// Reads an Obsidian datetime written in the course timezone back as an instant; other dates pass through.
export function zonedInstant(value: unknown, timezone = "Asia/Singapore"): string | null {
  const local = String(value ?? "").match(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/)?.[0];
  if (!local) return canvasDate(value);
  const offset = zonedDateTime(`${local}Z`, timezone)?.slice(-6) ?? "Z";
  return canvasDate(new Date(`${local}${offset}`).toISOString());
}

export function documentRecord({
  id,
  kind,
  course,
  title,
  sourceUrl = "",
  updatedAt = "",
  metadata = {},
  content = "",
  localPath = "",
}: DocumentInput): ArchiveDocument {
  const normalizedContent = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  return stableValue({
    document_id: `${course}:${kind}:${id}`,
    course,
    kind,
    title: String(title ?? ""),
    source_url: String(sourceUrl ?? ""),
    local_path: String(localPath ?? ""),
    updated_at: String(updatedAt ?? ""),
    metadata,
    content_sha256: sha256(normalizedContent),
    content: normalizedContent,
  }) as ArchiveDocument;
}

export function stateFromDocuments(documents: ArchiveDocument[]): ArchiveState {
  return Object.fromEntries(
    documents.map((document) => [
      document.document_id,
      {
        kind: document.kind,
        title: document.title,
        source_url: document.source_url,
        local_path: document.local_path,
        updated_at: document.updated_at,
        metadata: document.metadata,
        content_sha256: document.content_sha256,
      },
    ]),
  );
}

export function preserveIncompleteState(
  previous: ArchiveState = {},
  current: ArchiveState = {},
  incompleteKinds: string[] = [],
): ArchiveState {
  const incomplete = new Set(incompleteKinds);
  const preserved = { ...current };
  for (const [documentId, old] of Object.entries(previous)) {
    if (!preserved[documentId] && incomplete.has(old.kind)) preserved[documentId] = old;
  }
  return preserved;
}

export function compareStates(
  previous: ArchiveState = {},
  current: ArchiveState = {},
  incompleteKinds: string[] = [],
): ArchiveChange[] {
  const incomplete = new Set(incompleteKinds);
  const changes: ArchiveChange[] = [];
  for (const [id, after] of Object.entries(current)) {
    const before = previous[id];
    if (!before) {
      changes.push({ action: "added", document_id: id, kind: after.kind, title: after.title, fields: [] });
      continue;
    }
    const beforeFields = before as Record<string, unknown>;
    const afterFields = after as Record<string, unknown>;
    const fieldNames = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
    const fields = [...fieldNames]
      .sort()
      .filter((field) => stableJson(beforeFields[field], 0) !== stableJson(afterFields[field], 0))
      .map((field) => ({ field, before: beforeFields[field] ?? null, after: afterFields[field] ?? null }));
    if (fields.length)
      changes.push({ action: "modified", document_id: id, kind: after.kind, title: after.title, fields });
  }
  for (const [id, before] of Object.entries(previous)) {
    if (!current[id] && !incomplete.has(before.kind)) {
      changes.push({ action: "removed", document_id: id, kind: before.kind, title: before.title, fields: [] });
    }
  }
  return changes.sort((left, right) => left.document_id.localeCompare(right.document_id));
}
