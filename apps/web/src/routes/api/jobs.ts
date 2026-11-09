import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { createJob } from "@clipradar/db/jobs";
import { newJobOptions } from "@clipradar/db/rules";
import { createFileRoute } from "@tanstack/react-router";

import { ENV } from "@/env.server";
import { auth, db } from "@/services";

/**
 * POST /api/jobs?clipCount=10&language=id&name=talk.mp4
 * Body: the raw video bytes. The browser sends the File as is, no multipart.
 * 201 { jobId } | 400 | 401 | 413 { error }
 */
export const Route = createFileRoute("/api/jobs")({
  server: {
    handlers: {
      POST: ({ request }) => upload(request),
    },
  },
});

const BYTES_PER_MB = 1024 * 1024;

class UploadRejected extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function upload(request: Request): Promise<Response> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return Response.json({ error: "Sign in to upload." }, { status: 401 });
  }
  const options = newJobOptions.safeParse(
    Object.fromEntries(new URL(request.url).searchParams)
  );
  if (!(options.success && request.body)) {
    return Response.json({ error: "Invalid upload options." }, { status: 400 });
  }
  const maxBytes = ENV.MAX_UPLOAD_MB * BYTES_PER_MB;
  const declared = Number(request.headers.get("content-length") ?? 0);

  const sourcePath = join("sources", crypto.randomUUID());
  const absolute = join(ENV.DATA_DIR, sourcePath);
  const partial = `${absolute}.part`;
  try {
    if (declared > maxBytes) {
      throw tooLarge();
    }
    await mkdir(join(ENV.DATA_DIR, "sources"), { recursive: true });
    const written = await writeCapped(request.body, partial, maxBytes);
    if (declared && written !== declared) {
      throw new UploadRejected(400, "The upload ended early. Try again.");
    }
    await rename(partial, absolute);
  } catch (error) {
    await rm(partial, { force: true });
    if (error instanceof UploadRejected) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }

  // ponytail: a lost commit acknowledgement orphans this upload. The media sweep skips sources/, since no parent row can vouch for one.
  const jobId = await createJob(db, {
    userId: session.user.id,
    sourceName: options.data.name,
    sourcePath,
    clipCount: options.data.clipCount,
    language: options.data.language,
  });
  return Response.json({ jobId }, { status: 201 });
}

async function writeCapped(
  body: ReadableStream<Uint8Array>,
  path: string,
  maxBytes: number
): Promise<number> {
  const file = await open(path, "wx");
  try {
    let written = 0;
    for await (const chunk of body) {
      written += chunk.byteLength;
      if (written > maxBytes) {
        throw tooLarge();
      }
      await file.write(chunk);
    }
    if (written === 0) {
      throw new UploadRejected(400, "The upload was empty.");
    }
    return written;
  } finally {
    await file.close();
  }
}

function tooLarge(): UploadRejected {
  return new UploadRejected(
    413,
    `Videos up to ${ENV.MAX_UPLOAD_MB} MB are accepted.`
  );
}
