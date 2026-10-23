CREATE TABLE "labels" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"src" text NOT NULL,
	"uri" text NOT NULL,
	"val" text NOT NULL,
	"cid" text,
	"neg" boolean DEFAULT false NOT NULL,
	"cts" timestamp with time zone NOT NULL,
	"exp" timestamp with time zone,
	"sig" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "librarian_applications" (
	"did" text PRIMARY KEY NOT NULL,
	"handle" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text
);
--> statement-breakpoint
CREATE INDEX "labels_subject_idx" ON "labels" USING btree ("uri");--> statement-breakpoint
CREATE INDEX "labels_subject_val_idx" ON "labels" USING btree ("uri","val");--> statement-breakpoint
CREATE INDEX "librarian_applications_status_idx" ON "librarian_applications" USING btree ("status","requested_at");