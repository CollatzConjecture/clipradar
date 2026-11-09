import {
  type EditDraft,
  parseDocument,
  SettingsError,
} from "@clipradar/db/editor";
import { deleteJob, getJob, listJobs, retryJob } from "@clipradar/db/jobs";
import {
  type CreateVersionResult,
  createVersion,
  getClipEditor,
  listVersions,
} from "@clipradar/db/versions";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { protectedProcedure, router } from "../index";

const byId = z.object({ id: z.uuid() });

function found<T>(value: T | null, what = "Job"): T {
  if (value === null) {
    throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  }
  return value;
}

const REJECTED: Record<
  Extract<CreateVersionResult, { ok: false }>["reason"],
  "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "PRECONDITION_FAILED"
> = {
  "not-found": "NOT_FOUND",
  "request-reused": "CONFLICT",
  deleted: "CONFLICT",
  "invalid-settings": "BAD_REQUEST",
  "unsupported-feature": "BAD_REQUEST",
  "media-unavailable": "PRECONDITION_FAILED",
};

const settingsDocument = z.custom<EditDraft>();

function parsedDocument(value: unknown): EditDraft {
  try {
    return parseDocument(value);
  } catch (error) {
    if (error instanceof SettingsError) {
      // biome-ignore lint/style/useErrorCause: TRPCError takes the cause in its options, as passed here.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: error.message,
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Reads, retry, delete, and clip versions. Creating a job is `POST /api/jobs` (a
 * streaming upload, not JSON). Clip and version bytes come from
 * `GET /api/clips/:clipId[?v=N]`, source bytes from `GET /api/jobs/:jobId/source`.
 */
export const appRouter = router({
  jobs: router({
    /** Newest first. The app opens on the first one. */
    list: protectedProcedure.query(({ ctx }) =>
      listJobs(ctx.db, ctx.session.user.id)
    ),
    get: protectedProcedure
      .input(byId)
      .query(async ({ ctx, input }) =>
        found(await getJob(ctx.db, ctx.session.user.id, input.id))
      ),
    /** Idempotent. Returns the job as it is after the call. */
    retry: protectedProcedure
      .input(byId)
      .mutation(async ({ ctx, input }) =>
        found(await retryJob(ctx.db, ctx.session.user.id, input.id))
      ),
    /** At any status. The worker removes the job's files a few minutes later. */
    delete: protectedProcedure
      .input(byId)
      .mutation(async ({ ctx, input }) =>
        found(
          (await deleteJob(ctx.db, ctx.session.user.id, input.id))
            ? { id: input.id }
            : null
        )
      ),
  }),
  clips: router({
    /** The clip's original document, source facts, presets, and what this release lets the editor change. Ready clips only. */
    editor: protectedProcedure
      .input(byId)
      .query(async ({ ctx, input }) =>
        found(
          await getClipEditor(ctx.db, ctx.session.user.id, input.id),
          "Clip"
        )
      ),
    /** Newest first. The editor polls while any version is queued or rendering. */
    versions: protectedProcedure
      .input(byId)
      .query(async ({ ctx, input }) =>
        found(await listVersions(ctx.db, ctx.session.user.id, input.id), "Clip")
      ),
    /**
     * Queues the next numbered version. Idempotent per requestId, so a client
     * retry after a dropped response returns the same version.
     */
    export: protectedProcedure
      .input(
        z.object({
          id: z.uuid(),
          requestId: z.uuid(),
          settings: settingsDocument,
        })
      )
      .mutation(async ({ ctx, input }) => {
        const result = await createVersion(ctx.db, ctx.session.user.id, {
          clipId: input.id,
          requestId: input.requestId,
          settings: parsedDocument(input.settings),
        });
        if (!result.ok) {
          throw new TRPCError({
            code: REJECTED[result.reason],
            message: result.message,
          });
        }
        return result.version;
      }),
  }),
});

export type AppRouter = typeof appRouter;
