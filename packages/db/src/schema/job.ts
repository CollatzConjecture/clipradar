import { defineRelationsPart, sql } from "drizzle-orm";
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Word } from "../editor";
import { CLIP_COUNT, CLIP_SECONDS, SCORE } from "../rules";
import { user } from "./auth";

export type { Word } from "../editor";

export const jobStatus = pgEnum("job_status", [
  "queued",
  "transcribing",
  "selecting",
  "rendering",
  "completed",
  "partial",
  "failed",
]);
export type JobStatus = (typeof jobStatus.enumValues)[number];

export const RUNNING = [
  "transcribing",
  "selecting",
  "rendering",
] as const satisfies readonly JobStatus[];
export type RunningStatus = (typeof RUNNING)[number];

export const RETRYABLE = [
  "failed",
  "partial",
] as const satisfies readonly JobStatus[];

export const clipStatus = pgEnum("clip_status", ["pending", "ready", "failed"]);
export type ClipStatus = (typeof clipStatus.enumValues)[number];

export interface Segment {
  end: number;
  start: number;
  text: string;
  words: Word[];
}

// DDL cannot take bind parameters, so the rule numbers are inlined as literals.
const sqlList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));
const sqlNumber = (value: number) => sql.raw(String(value));
const timestamptz = (name: string) => timestamp(name, { withTimezone: true });

export const job = pgTable(
  "job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    sourceName: text("source_name").notNull(),
    sourcePath: text("source_path").notNull(),
    clipCount: smallint("clip_count").notNull(),
    language: text("language"),
    status: jobStatus("status").notNull().default("queued"),
    error: text("error"),
    attempt: integer("attempt").notNull().default(0),
    attemptsLeft: smallint("attempts_left").notNull(),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("job_queue_idx").on(t.status, t.createdAt),
    index("job_user_idx").on(t.userId, t.createdAt),
    check(
      "job_clip_count",
      sql`${t.clipCount} between ${sqlNumber(CLIP_COUNT.min)} and ${sqlNumber(CLIP_COUNT.max)}`
    ),
    check(
      "job_lease_iff_running",
      sql`(${t.status} in (${sqlList(RUNNING)})) = (${t.leaseExpiresAt} is not null)`
    ),
  ]
);

export const transcript = pgTable("transcript", {
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => job.id, { onDelete: "cascade" }),
  language: text("language").notNull(),
  durationSeconds: doublePrecision("duration_seconds").notNull(),
  segments: jsonb("segments").$type<Segment[]>().notNull(),
});

export const clip = pgTable(
  "clip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => job.id, { onDelete: "cascade" }),
    rank: smallint("rank").notNull(),
    startSeconds: doublePrecision("start_seconds").notNull(),
    endSeconds: doublePrecision("end_seconds").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    score: real("score").notNull(),
    status: clipStatus("status").notNull().default("pending"),
    error: text("error"),
    file: text("file"),
  },
  (t) => [
    uniqueIndex("clip_job_rank_idx").on(t.jobId, t.rank),
    check(
      "clip_score",
      sql`${t.score} between ${sqlNumber(SCORE.min)} and ${sqlNumber(SCORE.max)}`
    ),
    check(
      "clip_length",
      sql`${t.endSeconds} - ${t.startSeconds} between ${sqlNumber(CLIP_SECONDS.min)} and ${sqlNumber(CLIP_SECONDS.max)}`
    ),
    check(
      "clip_file_iff_ready",
      sql`(${t.status} = 'ready') = (${t.file} is not null)`
    ),
  ]
);

export const versionStatus = pgEnum("version_status", [
  "queued",
  "rendering",
  "ready",
  "failed",
]);
export type VersionStatus = (typeof versionStatus.enumValues)[number];

/**
 * One exported edit of a clip, numbered per clip. `settings` is the editor
 * document, written once at insert and parsed by editor.ts on the way in and
 * out; only the queue columns move after that. A deleted version keeps its
 * row, so its number and request id never mean anything else.
 */
export const clipVersion = pgTable(
  "clip_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clipId: uuid("clip_id")
      .notNull()
      .references(() => clip.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    /** Made by the browser per Export press, so a resubmit finds its version. */
    requestId: uuid("request_id").notNull(),
    settings: jsonb("settings").notNull(),
    status: versionStatus("status").notNull().default("queued"),
    error: text("error"),
    file: text("file"),
    attempt: integer("attempt").notNull().default(0),
    attemptsLeft: smallint("attempts_left").notNull(),
    leaseExpiresAt: timestamptz("lease_expires_at"),
    createdAt: timestamptz("created_at").defaultNow().notNull(),
    deletedAt: timestamptz("deleted_at"),
    /** Set once a deleted version's file is gone from disk. */
    filePurgedAt: timestamptz("file_purged_at"),
  },
  (t) => [
    uniqueIndex("clip_version_number_idx").on(t.clipId, t.number),
    uniqueIndex("clip_version_request_idx").on(t.clipId, t.requestId),
    index("clip_version_queue_idx").on(t.status, t.createdAt),
    check("clip_version_number", sql`${t.number} >= 1`),
    check(
      "clip_version_settings",
      sql`jsonb_typeof(${t.settings}) = 'object' and ${t.settings} -> 'version' = '2'::jsonb`
    ),
    check(
      "clip_version_lease_iff_rendering",
      sql`(${t.status} = 'rendering') = (${t.leaseExpiresAt} is not null)`
    ),
    check(
      "clip_version_file_iff_ready",
      sql`(${t.status} = 'ready') = (${t.file} is not null)`
    ),
    check(
      "clip_version_deleted_when_done",
      sql`${t.deletedAt} is null or ${t.status} in ('ready', 'failed')`
    ),
    check(
      "clip_version_purged_after_delete",
      sql`${t.filePurgedAt} is null or ${t.deletedAt} is not null`
    ),
  ]
);

/**
 * Media a delete left for the worker to remove: a file or a whole folder,
 * relative to DATA_DIR. The worker waits a little before removing each, so a
 * worker that was still rendering the deleted job has stopped writing there.
 */
export const mediaTrash = pgTable("media_trash", {
  path: text("path").primaryKey(),
  trashedAt: timestamptz("trashed_at").defaultNow().notNull(),
});

export const jobRelations = defineRelationsPart(
  { job, clip, transcript },
  (r) => ({
    job: {
      clips: r.many.clip({ from: r.job.id, to: r.clip.jobId }),
      transcript: r.one.transcript({ from: r.job.id, to: r.transcript.jobId }),
    },
    clip: {
      job: r.one.job({ from: r.clip.jobId, to: r.job.id }),
    },
  })
);
