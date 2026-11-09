import { openAsBlob } from "node:fs";
import { resolve, sep } from "node:path";

import { ENV } from "@/env.server";
import { parseRange } from "@/lib/byte-range";

export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CACHE_CONTROL = "private, max-age=31536000, immutable";

export interface ServedFile {
  contentType: string;
  /** Sent as an attachment name only when the request has `?download`. */
  downloadName: string;
  /** Relative to DATA_DIR, as stored in the database. */
  file: string;
}

export function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

/**
 * Serves a file the caller already checked the user may read. A path outside
 * DATA_DIR or a missing file is a 404. Single byte ranges are honored because
 * Safari will not play a <video> whose source ignores Range. Every file served
 * here is immutable once its row points at it, so it caches for a year.
 */
export async function serveFile(
  request: Request,
  served: ServedFile
): Promise<Response> {
  const root = resolve(ENV.DATA_DIR);
  const path = resolve(root, served.file);
  if (!path.startsWith(root + sep)) {
    return notFound();
  }
  const file = await openAsBlob(path).catch(() => null);
  if (!file) {
    return notFound();
  }

  const range = parseRange(request.headers.get("range"), file.size);
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${file.size}` },
    });
  }
  const { start, end } = range ?? { start: 0, end: file.size - 1 };
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": CACHE_CONTROL,
    "Content-Length": String(end - start + 1),
    "Content-Type": served.contentType,
  });
  if (range) {
    headers.set("Content-Range", `bytes ${start}-${end}/${file.size}`);
  }
  if (new URL(request.url).searchParams.has("download")) {
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(served.downloadName)}`
    );
  }
  return new Response(file.slice(start, end + 1), {
    status: range ? 206 : 200,
    headers,
  });
}
