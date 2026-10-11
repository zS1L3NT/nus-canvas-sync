import { canvasApiBody, canvasError, canvasJson } from "./canvas-client.ts";
import { canvasDate } from "./lib.ts";
import type { ArchiveConfig, CanvasWarning } from "./types.ts";

interface CanvasDates {
  _id: string;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface DatesResponse {
  data?: {
    course?: {
      records?: {
        nodes: Array<CanvasDates | null>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    } | null;
  };
  errors?: Array<{ message: string }>;
}

interface Timestamps {
  created_at?: string;
  updated_at?: string;
}

export async function collectCanvasTimestamps<T extends Timestamps & { id: number; title: string }>(
  config: ArchiveConfig,
  warnings: CanvasWarning[],
  courseId: number,
  kind: "quiz" | "announcement",
  records: T[],
  previous: Array<Timestamps & { id: number }> = [],
): Promise<Array<T & Timestamps>> {
  if (!records.length) return records;
  const saved = new Map(previous.map((record) => [record.id, record]));
  const fallback = records.map((record) => {
    const dates = saved.get(record.id);
    const created = canvasDate(record.created_at) ?? canvasDate(dates?.created_at);
    const updated = canvasDate(record.updated_at) ?? canvasDate(dates?.updated_at);
    return { ...record, ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}) };
  });
  const dates = new Map<string, CanvasDates>();
  const cursors = new Set<string>();
  let after: string | null = null;
  try {
    do {
      // POST transports a GraphQL query; no Canvas mutations or student records are requested.
      const response: DatesResponse = canvasApiBody<DatesResponse>(
        await canvasJson(config, [
          "api",
          "POST",
          "/api/graphql",
          "--data",
          JSON.stringify({
            query: `query ContentTimestamps($courseId: ID!, $after: String) {
              course(id: $courseId) {
                records: ${kind === "quiz" ? "quizzesConnection" : "discussionsConnection"}(first: 100, after: $after) {
                  nodes { _id createdAt updatedAt }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }`,
            variables: { courseId: String(courseId), after },
          }),
        ]),
      );
      if (response.errors?.length) throw new Error(response.errors.map((error) => error.message).join("; "));
      const connection = response.data?.course?.records;
      if (!connection) throw new Error(`Canvas returned no ${kind} timestamp collection`);
      for (const node of connection.nodes) {
        if (!node) throw new Error(`Canvas returned an inaccessible ${kind} timestamp record`);
        dates.set(String(node._id), node);
      }
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (!after || cursors.has(after))
        throw new Error(`Canvas returned a missing or repeated ${kind} pagination cursor`);
      cursors.add(after);
    } while (after);
  } catch (error) {
    warnings.push({
      kind: `${kind}-timestamps`,
      message: `Canvas ${kind} timestamps could not be refreshed; previously collected dates retained: ${canvasError(error).raw}`,
    });
    return fallback;
  }

  return fallback.map((record) => {
    const node = dates.get(String(record.id));
    const created = canvasDate(node?.createdAt);
    const updated = canvasDate(node?.updatedAt);
    if (!created || !updated)
      warnings.push({
        kind: `${kind}-timestamps`,
        id: String(record.id),
        message: `Canvas ${kind} "${record.title}" has missing or invalid timestamps; available dates retained.`,
      });
    return { ...record, ...(created ? { created_at: created } : {}), ...(updated ? { updated_at: updated } : {}) };
  });
}
