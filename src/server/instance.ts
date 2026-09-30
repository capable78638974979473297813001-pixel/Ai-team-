import { randomUUID } from "node:crypto";

/** Identifies this server process in task_runs.instance_id and event envelopes. */
const g = globalThis as unknown as { __aiteamInstance?: string };
export const INSTANCE_ID = (g.__aiteamInstance ??= `${process.pid}-${randomUUID().slice(0, 8)}`);
