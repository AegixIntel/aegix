import { z } from "zod";

export interface NotificationCursor {
  createdAt: string;
  id: string;
}

const cursorSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
  id: z.string().regex(/^\d+$/)
}).strict();

export function encodeNotificationCursor(cursor: NotificationCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeNotificationCursor(value: string): NotificationCursor {
  if (!value || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid notification cursor");
  }
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid notification cursor");
  }
}
