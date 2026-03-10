import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { createCalendarEvent, listBusyBlocks } from "@/lib/google";
import { buildSearchRange, findAvailableSlot } from "@/lib/scheduler";

export const runtime = "nodejs";

const scheduleRequestSchema = z.object({
  clientNow: z.string().optional(),
  durationMinutes: z.number().int().min(15).max(240),
  mode: z.enum(["preview", "book"]),
  notes: z.string().max(4000).default(""),
  preferredWindow: z.enum(["any", "morning", "afternoon", "evening"]),
  priority: z.enum(["high", "medium", "low"]),
  timeZone: z.string().min(2).max(100),
  title: z.string().trim().max(120),
});

function inferTitle(title: string, notes: string) {
  const cleanedTitle = title.trim();

  if (cleanedTitle) {
    return cleanedTitle;
  }

  const cleanedNotes = notes
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");

  return cleanedNotes ? `${cleanedNotes}${cleanedNotes.length >= 32 ? "..." : ""}` : "New agenda item";
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);

  if (!session?.accessToken) {
    return NextResponse.json(
      { error: "Connect Google first so I can read and update your calendar." },
      { status: 401 },
    );
  }

  let rawBody: unknown;

  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request payload." }, { status: 400 });
  }

  const parsed = scheduleRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "The scheduling request is missing required fields." },
      { status: 400 },
    );
  }

  const now = parsed.data.clientNow ? new Date(parsed.data.clientNow) : new Date();

  if (Number.isNaN(now.getTime())) {
    return NextResponse.json({ error: "The submitted time context was invalid." }, { status: 400 });
  }

  const title = inferTitle(parsed.data.title, parsed.data.notes);
  const searchRange = buildSearchRange({
    now,
    priority: parsed.data.priority,
    timeZone: parsed.data.timeZone,
  });

  try {
    const busyBlocks = await listBusyBlocks(
      session.accessToken,
      searchRange.timeMin,
      searchRange.timeMax,
      parsed.data.timeZone,
    );
    const scheduledSlot = findAvailableSlot(
      {
        durationMinutes: parsed.data.durationMinutes,
        now,
        preferredWindow: parsed.data.preferredWindow,
        priority: parsed.data.priority,
        timeZone: parsed.data.timeZone,
      },
      busyBlocks,
    );

    if (!scheduledSlot) {
      return NextResponse.json(
        {
          error:
            "I couldn't find an open slot with the current duration and priority. Try shortening the event or loosening the time window.",
        },
        { status: 409 },
      );
    }

    if (parsed.data.mode === "book") {
      const event = await createCalendarEvent(session.accessToken, {
        end: scheduledSlot.end,
        notes: parsed.data.notes,
        start: scheduledSlot.start,
        timeZone: parsed.data.timeZone,
        title,
      });

      return NextResponse.json({
        eventLink: event.htmlLink,
        slot: {
          bucket: scheduledSlot.bucket,
          end: scheduledSlot.end.toISOString(),
          start: scheduledSlot.start.toISOString(),
          timeZone: parsed.data.timeZone,
        },
        status: "booked",
        title,
        rationale: scheduledSlot.rationale,
      });
    }

    return NextResponse.json({
      slot: {
        bucket: scheduledSlot.bucket,
        end: scheduledSlot.end.toISOString(),
        start: scheduledSlot.start.toISOString(),
        timeZone: parsed.data.timeZone,
      },
      status: "previewed",
      title,
      rationale: scheduledSlot.rationale,
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Google Calendar rejected the request. Double-check your Google OAuth credentials and reconnect your account.",
      },
      { status: 502 },
    );
  }
}
