import { getSourceFile } from "@clipradar/db/jobs";
import { createFileRoute } from "@tanstack/react-router";

import { notFound, serveFile, UUID } from "@/lib/serve-file";
import { auth, db } from "@/services";

/**
 * GET /api/jobs/:jobId/source   the uploaded video, inline, for the editor.
 *
 * The editor previews the source, not the clip, because a trim can reach past
 * the clip and the crop shows what the 9:16 window leaves out. Sources are
 * stored without an extension, so the type comes from the upload's name.
 */
export const Route = createFileRoute("/api/jobs/$jobId/source")({
  server: {
    handlers: {
      GET: ({ request, params }) => serveSource(request, params.jobId),
    },
  },
});

const TYPES: Record<string, string> = {
  m4v: "video/mp4",
  mkv: "video/x-matroska",
  mov: "video/quicktime",
  mp4: "video/mp4",
  webm: "video/webm",
};

async function serveSource(request: Request, jobId: string): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!(session && UUID.test(jobId))) {
    return notFound();
  }
  const source = await getSourceFile(db, session.user.id, jobId);
  if (!source) {
    return notFound();
  }
  const extension = source.sourceName.split(".").at(-1)?.toLowerCase() ?? "";
  return serveFile(request, {
    file: source.file,
    contentType: TYPES[extension] ?? "application/octet-stream",
    downloadName: source.sourceName,
  });
}
