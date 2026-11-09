CREATE TABLE "media_trash" (
	"path" text PRIMARY KEY,
	"trashed_at" timestamp with time zone DEFAULT now() NOT NULL
);
