import { addDays } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { EventPriority, PreferredWindow } from "@/lib/scheduler";

type TimingMode = "exact" | "day" | "flexible";

type PromptTiming = {
  mode: TimingMode;
  requestedDateKey: string | null;
  requestedDateLabel: string;
  requestedStartIso: string | null;
  requestedTimeLabel: string | null;
};

type PromptDetails = {
  preferredWindow: PreferredWindow;
  priority: EventPriority;
  suggestedTitle: string | null;
  timing: PromptTiming;
};

type ExtractedTime = {
  hour: number;
  label: string;
  minute: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  friday: 5,
  monday: 1,
  saturday: 6,
  sunday: 0,
  thursday: 4,
  tuesday: 2,
  wednesday: 3,
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function normalizePromptText(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim();
}

function buildZonedDate(dateKey: string, hour: number, minute: number, timeZone: string) {
  return fromZonedTime(`${dateKey}T${pad(hour)}:${pad(minute)}:00`, timeZone);
}

function getLocalDateKey(date: Date, timeZone: string) {
  return formatInTimeZone(date, timeZone, "yyyy-MM-dd");
}

function getLocalWeekdayIndex(date: Date, timeZone: string) {
  return Number(formatInTimeZone(date, timeZone, "i")) % 7;
}

function buildTimeLabel(hour: number, minute: number) {
  const hour12 = hour % 12 || 12;
  const meridiem = hour >= 12 ? "PM" : "AM";
  return `${hour12}:${pad(minute)} ${meridiem}`;
}

function labelDateRelativeToNow(dateKey: string, now: Date, timeZone: string) {
  const todayKey = getLocalDateKey(now, timeZone);
  const tomorrowKey = getLocalDateKey(addDays(now, 1), timeZone);

  if (dateKey === todayKey) {
    return "today";
  }

  if (dateKey === tomorrowKey) {
    return "tomorrow";
  }

  return formatInTimeZone(buildZonedDate(dateKey, 12, 0, timeZone), timeZone, "EEEE");
}

function extractQuotedTitle(prompt: string) {
  const quotedMatch = prompt.match(/"([^"]{1,120})"/);

  if (quotedMatch?.[1]) {
    return quotedMatch[1].trim();
  }

  const namedMatch = prompt.match(
    /\b(?:call|name|title)\s+it\s+([^.,!?]+?)(?=\s+(?:at|for|today|tomorrow|on|later|next)\b|$)/i,
  );

  if (namedMatch?.[1]) {
    return normalizePromptText(namedMatch[1]).replace(/^["']|["']$/g, "");
  }

  return null;
}

function inferWindow(prompt: string): PreferredWindow {
  if (/\b(morning|am|before noon|early)\b/i.test(prompt)) {
    return "morning";
  }

  if (/\b(afternoon|after lunch)\b/i.test(prompt)) {
    return "afternoon";
  }

  if (/\b(evening|tonight|night)\b/i.test(prompt)) {
    return "evening";
  }

  return "any";
}

function extractTime(prompt: string): ExtractedTime | null {
  if (/\bnoon\b/i.test(prompt)) {
    return { hour: 12, label: "12:00 PM", minute: 0 };
  }

  if (/\bmidnight\b/i.test(prompt)) {
    return { hour: 0, label: "12:00 AM", minute: 0 };
  }

  const match = prompt.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/i);

  if (!match) {
    return null;
  }

  const rawHour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const meridiem = match[3].toLowerCase();
  const isPm = meridiem.startsWith("p");
  const hour = rawHour % 12 + (isPm ? 12 : 0);

  return {
    hour,
    label: buildTimeLabel(hour, minute),
    minute,
  };
}

function extractExplicitDateKey(prompt: string, now: Date, timeZone: string) {
  const loweredPrompt = prompt.toLowerCase();
  const todayKey = getLocalDateKey(now, timeZone);

  if (/\btoday\b/.test(loweredPrompt)) {
    return { dateKey: todayKey, label: "today" };
  }

  if (/\btomorrow\b/.test(loweredPrompt)) {
    return {
      dateKey: getLocalDateKey(addDays(now, 1), timeZone),
      label: "tomorrow",
    };
  }

  for (const [weekday, weekdayIndex] of Object.entries(WEEKDAY_INDEX)) {
    if (new RegExp(`\\b${weekday}\\b`, "i").test(prompt)) {
      const currentWeekday = getLocalWeekdayIndex(now, timeZone);
      let offset = weekdayIndex - currentWeekday;

      if (offset < 0) {
        offset += 7;
      }

      return {
        dateKey: getLocalDateKey(addDays(now, offset), timeZone),
        label: weekday,
      };
    }
  }

  return null;
}

function extractTiming(prompt: string, now: Date, timeZone: string): PromptTiming {
  const normalizedPrompt = normalizePromptText(prompt);
  const time = extractTime(normalizedPrompt);
  const explicitDate = extractExplicitDateKey(normalizedPrompt, now, timeZone);

  if (time) {
    const initialDateKey =
      explicitDate?.dateKey ?? getLocalDateKey(now, timeZone);
    let requestedStart = buildZonedDate(
      initialDateKey,
      time.hour,
      time.minute,
      timeZone,
    );
    let dateLabel =
      explicitDate?.label ?? labelDateRelativeToNow(initialDateKey, now, timeZone);

    if (!explicitDate && requestedStart < now) {
      const nextDateKey = getLocalDateKey(addDays(now, 1), timeZone);
      requestedStart = buildZonedDate(nextDateKey, time.hour, time.minute, timeZone);
      dateLabel = "tomorrow";
    }

    return {
      mode: "exact",
      requestedDateKey: getLocalDateKey(requestedStart, timeZone),
      requestedDateLabel: `${dateLabel} at ${time.label}`,
      requestedStartIso: requestedStart.toISOString(),
      requestedTimeLabel: time.label,
    };
  }

  if (explicitDate) {
    return {
      mode: "day",
      requestedDateKey: explicitDate.dateKey,
      requestedDateLabel: explicitDate.label,
      requestedStartIso: null,
      requestedTimeLabel: null,
    };
  }

  if (/\blater this week\b/i.test(normalizedPrompt)) {
    return {
      mode: "flexible",
      requestedDateKey: null,
      requestedDateLabel: "later this week",
      requestedStartIso: null,
      requestedTimeLabel: null,
    };
  }

  if (/\bnext week\b/i.test(normalizedPrompt)) {
    return {
      mode: "flexible",
      requestedDateKey: null,
      requestedDateLabel: "next week",
      requestedStartIso: null,
      requestedTimeLabel: null,
    };
  }

  return {
    mode: "flexible",
    requestedDateKey: null,
    requestedDateLabel: "best available time",
    requestedStartIso: null,
    requestedTimeLabel: null,
  };
}

function inferPriority(prompt: string, timing: PromptTiming): EventPriority {
  if (/\b(urgent|asap|immediately|right away|high priority)\b/i.test(prompt)) {
    return "high";
  }

  if (/\b(low priority|not urgent|whenever|sometime)\b/i.test(prompt)) {
    return "low";
  }

  if (timing.mode === "flexible") {
    if (/\blater this week|next week\b/i.test(prompt)) {
      return "low";
    }

    if (/\btoday\b/i.test(prompt)) {
      return "high";
    }
  }

  return "medium";
}

function extractPromptDetails(
  prompt: string,
  context: {
    now: Date;
    timeZone: string;
  },
): PromptDetails {
  const normalizedPrompt = normalizePromptText(prompt);
  const timing = extractTiming(normalizedPrompt, context.now, context.timeZone);

  return {
    preferredWindow: inferWindow(normalizedPrompt),
    priority: inferPriority(normalizedPrompt, timing),
    suggestedTitle: extractQuotedTitle(normalizedPrompt),
    timing,
  };
}

export { extractPromptDetails, normalizePromptText };
export type { PromptDetails, PromptTiming, TimingMode };
