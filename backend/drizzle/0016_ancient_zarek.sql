-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

-- 1. New tables: workspaces, workspace_members, pending_memberships (all synced via PowerSync).
CREATE TABLE "powersync"."workspaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"welcome_message" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"is_personal" boolean DEFAULT false NOT NULL,
	"icon" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "powersync"."workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp NOT NULL,
	"removed_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "powersync"."pending_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint

-- 2. Drop existing user_id FKs on workspace-scoped tables so we can alter the column.
ALTER TABLE "powersync"."chat_messages" DROP CONSTRAINT "chat_messages_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" DROP CONSTRAINT "chat_threads_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" DROP CONSTRAINT "mcp_servers_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" DROP CONSTRAINT "model_profiles_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."models" DROP CONSTRAINT "models_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."modes" DROP CONSTRAINT "modes_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."prompts" DROP CONSTRAINT "prompts_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."tasks" DROP CONSTRAINT "tasks_user_id_user_id_fk";--> statement-breakpoint
ALTER TABLE "powersync"."triggers" DROP CONSTRAINT "triggers_user_id_user_id_fk";--> statement-breakpoint

-- 3. Drop existing primary keys.
--    Single-column id PK on chat_messages / chat_threads / mcp_servers / triggers uses the
--    Postgres default name "<table>_pkey". Composite (id, user_id) PKs use Drizzle's naming.
ALTER TABLE "powersync"."chat_messages" DROP CONSTRAINT "chat_messages_pkey";--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" DROP CONSTRAINT "chat_threads_pkey";--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" DROP CONSTRAINT "mcp_servers_pkey";--> statement-breakpoint
ALTER TABLE "powersync"."triggers" DROP CONSTRAINT "triggers_pkey";--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" DROP CONSTRAINT "model_profiles_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."models" DROP CONSTRAINT "models_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."modes" DROP CONSTRAINT "modes_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."prompts" DROP CONSTRAINT "prompts_id_user_id_pk";--> statement-breakpoint
ALTER TABLE "powersync"."tasks" DROP CONSTRAINT "tasks_id_user_id_pk";--> statement-breakpoint

-- 4. Relax user_id to nullable on workspace-scoped tables (content survives author deletion).
ALTER TABLE "powersync"."chat_messages" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint

-- 5. Add workspace_id column. Safe as NOT NULL because the DB resets on this release (no rows).
ALTER TABLE "powersync"."chat_messages" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD COLUMN "workspace_id" text NOT NULL;--> statement-breakpoint

-- 6. Add uniform composite primary keys (id, workspace_id) per Decision 17.
ALTER TABLE "powersync"."chat_messages" ADD CONSTRAINT "chat_messages_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD CONSTRAINT "chat_threads_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD CONSTRAINT "mcp_servers_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD CONSTRAINT "tasks_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD CONSTRAINT "triggers_id_workspace_id_pk" PRIMARY KEY("id","workspace_id");--> statement-breakpoint

-- 7. Foreign keys for the new tables and the new workspace_id / relaxed user_id columns.
ALTER TABLE "powersync"."workspaces" ADD CONSTRAINT "workspaces_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."workspace_members" ADD CONSTRAINT "workspace_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."pending_memberships" ADD CONSTRAINT "pending_memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."pending_memberships" ADD CONSTRAINT "pending_memberships_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_messages" ADD CONSTRAINT "chat_messages_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD CONSTRAINT "chat_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."chat_threads" ADD CONSTRAINT "chat_threads_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."model_profiles" ADD CONSTRAINT "model_profiles_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD CONSTRAINT "models_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."modes" ADD CONSTRAINT "modes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."prompts" ADD CONSTRAINT "prompts_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."tasks" ADD CONSTRAINT "tasks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "powersync"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "powersync"."triggers" ADD CONSTRAINT "triggers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- 8. Indexes.
CREATE UNIQUE INDEX "workspaces_personal_per_user_idx" ON "powersync"."workspaces" USING btree ("created_by") WHERE is_personal = true;--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_idx" ON "powersync"."workspaces" USING btree ("slug") WHERE slug IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user_id" ON "powersync"."workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pending_memberships_workspace_email_idx" ON "powersync"."pending_memberships" USING btree ("workspace_id",lower("email"));--> statement-breakpoint
CREATE INDEX "idx_pending_memberships_workspace_id" ON "powersync"."pending_memberships" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_messages_workspace_id" ON "powersync"."chat_messages" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_chat_threads_workspace_id" ON "powersync"."chat_threads" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_servers_workspace_id" ON "powersync"."mcp_servers" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_model_profiles_workspace_id" ON "powersync"."model_profiles" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_models_workspace_id" ON "powersync"."models" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_modes_workspace_id" ON "powersync"."modes" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_prompts_workspace_id" ON "powersync"."prompts" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_workspace_id" ON "powersync"."tasks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_triggers_workspace_id" ON "powersync"."triggers" USING btree ("workspace_id");
