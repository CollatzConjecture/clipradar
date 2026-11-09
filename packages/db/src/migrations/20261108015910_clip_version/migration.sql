CREATE TYPE "version_status" AS ENUM('queued', 'rendering', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "clip_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"clip_id" uuid NOT NULL,
	"number" smallint NOT NULL,
	"request_id" uuid NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"crop_x" double precision NOT NULL,
	"captions" boolean NOT NULL,
	"caption_edits" jsonb NOT NULL,
	"status" "version_status" DEFAULT 'queued'::"version_status" NOT NULL,
	"error" text,
	"file" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"attempts_left" smallint NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clip_version_number" CHECK ("number" >= 1),
	CONSTRAINT "clip_version_length" CHECK ("start_seconds" >= 0 and "end_seconds" - "start_seconds" between 1 and 180),
	CONSTRAINT "clip_version_crop" CHECK ("crop_x" between 0 and 1),
	CONSTRAINT "clip_version_edits_array" CHECK (jsonb_typeof("caption_edits") = 'array'),
	CONSTRAINT "clip_version_lease_iff_rendering" CHECK (("status" = 'rendering') = ("lease_expires_at" is not null)),
	CONSTRAINT "clip_version_file_iff_ready" CHECK (("status" = 'ready') = ("file" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "clip_version_number_idx" ON "clip_version" ("clip_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_version_request_idx" ON "clip_version" ("clip_id","request_id");--> statement-breakpoint
CREATE INDEX "clip_version_queue_idx" ON "clip_version" ("status","created_at");--> statement-breakpoint
ALTER TABLE "clip_version" ADD CONSTRAINT "clip_version_clip_id_clip_id_fkey" FOREIGN KEY ("clip_id") REFERENCES "clip"("id") ON DELETE CASCADE;