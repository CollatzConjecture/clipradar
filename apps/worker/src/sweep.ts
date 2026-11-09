import { relative, resolve, sep } from "node:path";

import type { MediaReferences } from "@clipradar/db/media";

/** Long enough that a file renamed into place has had its publish committed. */
export const ORPHAN_AGE_MS = 60 * 60_000;
const MEDIA_DIRS = new Set(["sources", "clips", "versions"]);

export interface MediaFile {
  mtimeMs: number;
  /** `clips/<job id>/<name>` or `versions/<clip id>/<name>`, relative to DATA_DIR. */
  path: string;
}

/**
 * Files in a job's or clip's folder that no row names, once old enough that
 * no publish can still be on its way. A folder whose job or clip row is
 * missing is left alone: removing it is a delete's work, and a missing row
 * may mean a database that does not belong to this volume.
 */
export function orphans(
  files: readonly MediaFile[],
  refs: MediaReferences,
  now: number
): string[] {
  const parents: Record<string, ReadonlySet<string>> = {
    clips: refs.jobIds,
    versions: refs.clipIds,
  };
  return files
    .filter(({ path, mtimeMs }) => {
      const [top = "", parent = ""] = path.split("/");
      return (
        (parents[top]?.has(parent) ?? false) &&
        !refs.files.has(path) &&
        now - mtimeMs > ORPHAN_AGE_MS
      );
    })
    .map(({ path }) => path);
}

/** The absolute path a trashed path names, or null unless it is inside a media folder. */
export function trashTarget(dataDir: string, path: string): string | null {
  const absolute = resolve(dataDir, path);
  const [top = "", ...rest] = relative(dataDir, absolute).split(sep);
  return MEDIA_DIRS.has(top) && rest.length > 0 ? absolute : null;
}
