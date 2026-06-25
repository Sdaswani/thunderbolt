-- This Source Code Form is subject to the terms of the Mozilla Public
-- License, v. 2.0. If a copy of the MPL was not distributed with this
-- file, You can obtain one at http://mozilla.org/MPL/2.0/.

ALTER TABLE "powersync"."models" ADD COLUMN "accepts_images" integer;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "native_file_types" text;--> statement-breakpoint
ALTER TABLE "powersync"."models" ADD COLUMN "max_file_bytes" integer;