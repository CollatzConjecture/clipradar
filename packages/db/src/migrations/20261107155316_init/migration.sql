CREATE TYPE "clip_status" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "job_status" AS ENUM('queued', 'transcribing', 'selecting', 'rendering', 'completed', 'partial', 'failed');--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clip" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"job_id" uuid NOT NULL,
	"rank" smallint NOT NULL,
	"start_seconds" double precision NOT NULL,
	"end_seconds" double precision NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"score" real NOT NULL,
	"status" "clip_status" DEFAULT 'pending'::"clip_status" NOT NULL,
	"error" text,
	"file" text,
	CONSTRAINT "clip_score" CHECK ("score" between 0 and 10),
	CONSTRAINT "clip_length" CHECK ("end_seconds" - "start_seconds" between 15 and 60),
	CONSTRAINT "clip_file_iff_ready" CHECK (("status" = 'ready') = ("file" is not null))
);
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" text NOT NULL,
	"source_name" text NOT NULL,
	"source_path" text NOT NULL,
	"clip_count" smallint NOT NULL,
	"language" text,
	"status" "job_status" DEFAULT 'queued'::"job_status" NOT NULL,
	"error" text,
	"attempt" integer DEFAULT 0 NOT NULL,
	"attempts_left" smallint NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_clip_count" CHECK ("clip_count" between 1 and 20),
	CONSTRAINT "job_lease_iff_running" CHECK (("status" in ('transcribing', 'selecting', 'rendering')) = ("lease_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "transcript" (
	"job_id" uuid PRIMARY KEY,
	"language" text NOT NULL,
	"duration_seconds" double precision NOT NULL,
	"segments" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "clip_job_rank_idx" ON "clip" ("job_id","rank");--> statement-breakpoint
CREATE INDEX "job_queue_idx" ON "job" ("status","created_at");--> statement-breakpoint
CREATE INDEX "job_user_idx" ON "job" ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "clip" ADD CONSTRAINT "clip_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "transcript" ADD CONSTRAINT "transcript_job_id_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "job"("id") ON DELETE CASCADE;