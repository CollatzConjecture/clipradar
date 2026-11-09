import { getClipFile } from "@clipradar/db/jobs";
import { getVersionFile } from "@clipradar/db/versions";
import { createFileRoute } from "@tanstack/react-router";

import { notFound, serveFile, UUID } from "@/lib/serve-file";
import { auth, db } from "@/services";

/**
 * GET /api/clips/:clipId                  the job's render, inline, for <video src>
 * GET /api/clips/:clipId?download=1       the job's render as an attachment
 * GET /api/clips/:clipId?v=3[&download=1] the clip's version 3, the same two ways
 *
 * Missing, foreign, not-yet-ready, and malformed all answer 404, so the route
 * never reveals which clips or versions exist.
 */
export const Route = createFileRoute("/api/clips/$clipId")({
  server: {
    handlers: {
      GET: ({ request, params }) => serveClip(request, params.clipId),
    },
  },
});

const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;
const MAX_SLUG_CHARS = 60;
const VERSION = /^[1-9]\d{0,8}$/u;

async function serveClip(request: Request, clipId: string): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!(session && UUID.test(clipId))) {
    return notFound();
  }
  const v = new URL(request.url).searchParams.get("v");
  if (v !== null && !VERSION.test(v)) {
    return notFound();
  }
  const found =
    v === null
      ? await clipFile(session.user.id, clipId)
      : await versionFile(session.user.id, clipId, Number(v));
  if (!found) {
    return notFound();
  }
  return serveFile(request, {
    file: found.file,
    contentType: "video/mp4",
    downloadName: found.downloadName,
  });
}

async function clipFile(userId: string, clipId: string) {
  const clip = await getClipFile(db, userId, clipId);
  return (
    clip && {
      file: clip.file,
      downloadName: `${clip.rank}-${slug(clip.title)}.mp4`,
    }
  );
}

async function versionFile(userId: string, clipId: string, number: number) {
  const version = await getVersionFile(db, userId, clipId, number);
  return (
    version && {
      file: version.file,
      downloadName: `${slug(version.name)}-v${version.number}.mp4`,
    }
  );
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(NOT_LETTER_OR_DIGIT, "-")
      .slice(0, MAX_SLUG_CHARS)
      .replace(EDGE_DASHES, "") || "clip"
  );
}
