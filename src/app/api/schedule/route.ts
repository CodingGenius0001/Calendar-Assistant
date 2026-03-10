import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { createCalendarEvent, listBusyBlocks } from "@/lib/google";
import { toDisplayTitle } from "@/lib/prompt-details";
import {
  buildSelectedSlot,
  buildExactSearchRange,
  buildRequestedDaySearchRange,
  buildSearchRange,
  findAvailableSlot,
  findAlternativeSlots,
  getLocalDateKey,
} from "@/lib/scheduler";

export const runtime = "nodejs";

const scheduleRequestSchema = z.object({
  attendeeEmails: z.array(z.string().email()).max(20).default([]),
  clientNow: z.string().optional(),
  durationMinutes: z.number().int().min(15).max(240),
  mode: z.enum(["preview", "book"]),
  notes: z.string().max(4000).default(""),
  preferredWindow: z.enum(["any", "morning", "afternoon", "evening"]),
  priority: z.enum(["high", "medium", "low"]),
  promptTiming: z.object({
    mode: z.enum(["exact", "day", "flexible"]),
    requestedDateKey: z.string().nullable(),
    requestedDateLabel: z.string().max(120),
    requestedStartIso: z.string().nullable(),
    requestedTimeLabel: z.string().nullable(),
  }),
  reminderMinutes: z.array(z.number().int().min(1).max(10080)).max(10).default([]),
  selectedSlotStartIso: z.string().nullable().optional(),
  timeZone: z.string().min(2).max(100),
  title: z.string().trim().max(120),
});

function inferTitle(title: string, notes: string) {
  const cleanedTitle = title.trim();

  if (cleanedTitle) {
    return toDisplayTitle(cleanedTitle);
  }

  const cleanedNotes = notes
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 6)
    .join(" ");

  return cleanedNotes
    ? toDisplayTitle(`${cleanedNotes}${cleanedNotes.length >= 32 ? "..." : ""}`)
    : "Scheduled Meeting";
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
  const requestedStart = parsed.data.promptTiming.requestedStartIso
    ? new Date(parsed.data.promptTiming.requestedStartIso)
    : null;
  const selectedSlotStart = parsed.data.selectedSlotStartIso
    ? new Date(parsed.data.selectedSlotStartIso)
    : null;

  if (requestedStart && Number.isNaN(requestedStart.getTime())) {
    return NextResponse.json({ error: "The requested start time was invalid." }, { status: 400 });
  }

  if (selectedSlotStart && Number.isNaN(selectedSlotStart.getTime())) {
    return NextResponse.json(
      { error: "The selected slot time was invalid." },
      { status: 400 },
    );
  }

  const searchRange =
    selectedSlotStart
      ? buildExactSearchRange(selectedSlotStart, parsed.data.timeZone)
      : parsed.data.promptTiming.mode === "exact" && requestedStart
      ? buildExactSearchRange(requestedStart, parsed.data.timeZone)
      : parsed.data.promptTiming.mode === "day" && parsed.data.promptTiming.requestedDateKey
        ? buildRequestedDaySearchRange(
            parsed.data.promptTiming.requestedDateKey,
            parsed.data.timeZone,
          )
        : buildSearchRange({
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
    const scheduledSlot = selectedSlotStart
      ? buildSelectedSlot(
          {
            durationMinutes: parsed.data.durationMinutes,
            now,
            requestedStart,
            selectedStart: selectedSlotStart,
            timeZone: parsed.data.timeZone,
          },
          busyBlocks,
        )
      : findAvailableSlot(
          {
            durationMinutes: parsed.data.durationMinutes,
            now,
            preferredWindow: parsed.data.preferredWindow,
            priority: parsed.data.priority,
            requestedDateKey: parsed.data.promptTiming.requestedDateKey,
            requestedStart,
            timingMode: parsed.data.promptTiming.mode,
            timeZone: parsed.data.timeZone,
          },
          busyBlocks,
        );

    if (!scheduledSlot) {
      const timingError = selectedSlotStart
        ? "That alternative time is no longer open on your calendar. Pick another slot and try again."
        : parsed.data.promptTiming.mode === "exact"
          ? requestedStart && requestedStart < now
            ? "The original time has already passed, and I could not find another opening later that day. Edit the prompt or choose a later time."
            : "The exact time you asked for is unavailable, and I could not find another opening later that day. Edit the prompt or choose a different time."
          : parsed.data.promptTiming.mode === "day"
            ? `I couldn't find an opening on ${parsed.data.promptTiming.requestedDateLabel}. Edit the prompt or try a different day.`
            : "I couldn't find an open slot with the current duration and priority. Try shortening the event or loosening the time window.";

      return NextResponse.json(
        {
          error: timingError,
        },
        { status: 409 },
      );
    }

    if (parsed.data.mode === "book") {
      const event = await createCalendarEvent(session.accessToken, {
        attendeeEmails: parsed.data.attendeeEmails,
        end: scheduledSlot.end,
        notes: parsed.data.notes,
        reminderMinutes: parsed.data.reminderMinutes,
        start: scheduledSlot.start,
        timeZone: parsed.data.timeZone,
        title,
      });

      return NextResponse.json({
        eventLink: event.htmlLink,
        meetLink: event.meetLink,
        matchType: scheduledSlot.matchType,
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

    const alternativeSlots = findAlternativeSlots(
      {
        durationMinutes: parsed.data.durationMinutes,
        now,
        timeZone: parsed.data.timeZone,
      },
      busyBlocks,
      getLocalDateKey(scheduledSlot.start, parsed.data.timeZone),
      scheduledSlot.end,
      5,
    );

    return NextResponse.json({
      alternativeSlots: alternativeSlots.map((slot) => ({
        bucket: slot.bucket,
        end: slot.end.toISOString(),
        start: slot.start.toISOString(),
        timeZone: parsed.data.timeZone,
      })),
      matchType: scheduledSlot.matchType,
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
