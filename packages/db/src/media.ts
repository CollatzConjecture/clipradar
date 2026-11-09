/**
 * What the worker's media sweep reads and clears. media_trash holds what
 * deleteJob left behind. The references are the rows that still point at
 * media, so the sweep can tell a live file from the orphan of a publish
 * whose commit acknowledgement was lost.
 */
import { inArray, isNotNull, lt, sql } from "drizzle-orm";

import type { Database } from "./index";
import { clip, clipVersion, mediaTrash } from "./schema/job";

export interface MediaReferences {
  /** Clip ids, which name the folders under versions/. */
  clipIds: ReadonlySet<string>;
  /** Every file a clip or version row names, relative to DATA_DIR. */
  files: ReadonlySet<string>;
  /** Ids of jobs with clips, which name the folders under clips/. */
  jobIds: ReadonlySet<string>;
}

/** Trashed paths that have waited longer than `seconds`, oldest first. */
export async function trashedBefore(
  db: Database,
  seconds: number
): Promise<string[]> {
  const rows = await db
    .select({ path: mediaTrash.path })
    .from(mediaTrash)
    .where(
      lt(mediaTrash.trashedAt, sql`now() - make_interval(secs => ${seconds})`)
    )
    .orderBy(mediaTrash.trashedAt);
  return rows.map(({ path }) => path);
}

/** Forgets trashed paths once they are gone from disk. */
export async function clearTrash(
  db: Database,
  paths: readonly string[]
): Promise<void> {
  if (paths.length > 0) {
    await db.delete(mediaTrash).where(inArray(mediaTrash.path, [...paths]));
  }
}

// ponytail: reads every clip and version file name per sweep; page through them if an install holds millions.
export async function mediaReferences(db: Database): Promise<MediaReferences> {
  const [clips, versions] = await Promise.all([
    db.select({ id: clip.id, jobId: clip.jobId, file: clip.file }).from(clip),
    db
      .select({ file: clipVersion.file })
      .from(clipVersion)
      .where(isNotNull(clipVersion.file)),
  ]);
  return {
    jobIds: new Set(clips.map(({ jobId }) => jobId)),
    clipIds: new Set(clips.map(({ id }) => id)),
    files: new Set(
      [...clips, ...versions].flatMap(({ file }) => (file ? [file] : []))
    ),
  };
}
