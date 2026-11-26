CREATE TABLE "github_review" (
	"id" text PRIMARY KEY NOT NULL,
	"link_id" text NOT NULL,
	"kind" text NOT NULL,
	"revision" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp DEFAULT (now() AT TIME ZONE 'utc') NOT NULL,
	"completed_at" timestamp,
	CONSTRAINT "github_review_revision_unique" UNIQUE("link_id","kind","revision")
);
--> statement-breakpoint
ALTER TABLE "github_review" ADD CONSTRAINT "github_review_link_id_external_link_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."external_link"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_review_pending_idx" ON "github_review" USING btree ("next_attempt_at") WHERE "github_review"."completed_at" is null;