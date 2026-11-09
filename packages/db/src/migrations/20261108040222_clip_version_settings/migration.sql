-- Old version rows hold no version 2 document to become. Nothing is published, so they go; jobs, clips, transcripts and sources stay.
DELETE FROM "clip_version";--> statement-breakpoint
ALTER TABLE "clip_version" DROP CONSTRAINT "clip_version_length";--> statement-breakpoint
ALTER TABLE "clip_version" DROP CONSTRAINT "clip_version_crop";--> statement-breakpoint
ALTER TABLE "clip_version" DROP CONSTRAINT "clip_version_edits_array";--> statement-breakpoint
ALTER TABLE "clip_version" ADD COLUMN "settings" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clip_version" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clip_version" ADD COLUMN "file_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clip_version" DROP COLUMN "start_seconds";--> statement-breakpoint
ALTER TABLE "clip_version" DROP COLUMN "end_seconds";--> statement-breakpoint
ALTER TABLE "clip_version" DROP COLUMN "crop_x";--> statement-breakpoint
ALTER TABLE "clip_version" DROP COLUMN "captions";--> statement-breakpoint
ALTER TABLE "clip_version" DROP COLUMN "caption_edits";--> statement-breakpoint
ALTER TABLE "clip_version" ALTER COLUMN "number" SET DATA TYPE integer USING "number"::integer;--> statement-breakpoint
ALTER TABLE "clip_version" ADD CONSTRAINT "clip_version_settings" CHECK (jsonb_typeof("settings") = 'object' and "settings" -> 'version' = '2'::jsonb);--> statement-breakpoint
ALTER TABLE "clip_version" ADD CONSTRAINT "clip_version_deleted_when_done" CHECK ("deleted_at" is null or "status" in ('ready', 'failed'));--> statement-breakpoint
ALTER TABLE "clip_version" ADD CONSTRAINT "clip_version_purged_after_delete" CHECK ("file_purged_at" is null or "deleted_at" is not null);