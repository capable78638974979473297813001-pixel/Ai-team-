DROP INDEX "tasks_user_idx";--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "provider_events_created_idx" ON "provider_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "task_runs_active_idx" ON "task_runs" USING btree ("status","heartbeat_at") WHERE "task_runs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "tasks_user_idx" ON "tasks" USING btree ("user_id","updated_at","id");