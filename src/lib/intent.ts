import { z } from "zod";

const calendarIntentSchema = z.object({
  action: z.literal("schedule_event"),
  confidence: z.enum(["low", "medium", "high"]),
  durationMinutes: z.number().int().min(15).max(240),
  needsClarification: z.boolean(),
  notes: z.string().max(4000),
  preferredWindow: z.enum(["any", "morning", "afternoon", "evening"]),
  priority: z.enum(["high", "medium", "low"]),
  requestedDateLabel: z.string().max(120),
  title: z.string().min(1).max(120),
  userConfirmationMessage: z.string().min(1).max(400),
});

const calendarIntentJsonSchema = {
  additionalProperties: false,
  properties: {
    action: {
      const: "schedule_event",
      type: "string",
    },
    confidence: {
      enum: ["low", "medium", "high"],
      type: "string",
    },
    durationMinutes: {
      type: "integer",
    },
    needsClarification: {
      type: "boolean",
    },
    notes: {
      type: "string",
    },
    preferredWindow: {
      enum: ["any", "morning", "afternoon", "evening"],
      type: "string",
    },
    priority: {
      enum: ["high", "medium", "low"],
      type: "string",
    },
    requestedDateLabel: {
      type: "string",
    },
    title: {
      type: "string",
    },
    userConfirmationMessage: {
      type: "string",
    },
  },
  required: [
    "action",
    "confidence",
    "durationMinutes",
    "needsClarification",
    "notes",
    "preferredWindow",
    "priority",
    "requestedDateLabel",
    "title",
    "userConfirmationMessage",
  ],
  type: "object",
} as const;

export { calendarIntentJsonSchema, calendarIntentSchema };
export type CalendarIntent = z.infer<typeof calendarIntentSchema>;
