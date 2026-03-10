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
  attendeeEmails: string[];
  explicitDurationMinutes: number | null;
  preferredWindow: PreferredWindow;
  priority: EventPriority;
  reminderMinutes: number[];
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

const GENERIC_TITLE_CANDIDATES = new Set([
  "agenda item",
  "appointment",
  "call",
  "chat",
  "event",
  "meeting",
  "new agenda item",
  "phone call",
  "scheduled appointment",
  "scheduled call",
  "scheduled event",
  "scheduled meeting",
  "session",
  "sync",
]);

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function normalizePromptText(prompt: string) {
  return prompt.replace(/\s+/g, " ").trim();
}

function toDisplayTitle(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const loweredWord = word.toLowerCase();

      if (["a", "an", "and", "at", "for", "in", "of", "on", "or", "the", "to", "with"].includes(loweredWord)) {
        return loweredWord;
      }

      return loweredWord.charAt(0).toUpperCase() + loweredWord.slice(1);
    })
    .join(" ")
    .replace(/\b(a|an|and|at|for|in|of|on|or|the|to|with)\b/, (word) =>
      word.charAt(0).toUpperCase() + word.slice(1),
    );
}

function normalizeTitleCandidate(value: string) {
  return normalizePromptText(
    value
      .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "")
      .replace(/\b(?:please|schedule|set up|book|create|add|make it|make)\b/gi, "")
      .replace(/\b(?:today|tomorrow|tonight|later this week|next week)\b/gi, "")
      .replace(
        /\b(?:at|for|on|by|before|after|invite|with reminder|remind|email)\b.*$/i,
        "",
      ),
  );
}

function isGenericTitleCandidate(value: string) {
  const normalized = normalizePromptText(value).toLowerCase();
  return !normalized || GENERIC_TITLE_CANDIDATES.has(normalized);
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
    const candidate = toDisplayTitle(quotedMatch[1].trim());
    return isGenericTitleCandidate(candidate) ? null : candidate;
  }

  const namedMatch = prompt.match(
    /\b(?:call|name|title)\s+it\s+([^.,!?]+?)(?=\s+(?:at|for|today|tomorrow|on|later|next)\b|$)/i,
  );

  if (namedMatch?.[1]) {
    const candidate = toDisplayTitle(
      normalizePromptText(namedMatch[1]).replace(/^["']|["']$/g, ""),
    );
    return isGenericTitleCandidate(candidate) ? null : candidate;
  }

  return null;
}

function extractContextualTitle(prompt: string) {
  const withMatch = prompt.match(
    /\b(meeting|call|chat|sync|appointment|session)\s+with\s+([^.,!?]+?)(?=\s+(?:at|for|today|tomorrow|on|later|next|this|invite|remind|email|with reminders?|and\s+invite)\b|$)/i,
  );

  if (withMatch?.[1] && withMatch[2]) {
    return toDisplayTitle(
      normalizeTitleCandidate(`${withMatch[1]} with ${withMatch[2]}`),
    );
  }

  const aboutMatch = prompt.match(
    /\b(?:meeting|call|chat|sync|session)\s+(?:about|regarding)\s+([^.,!?]+?)(?=\s+(?:at|for|today|tomorrow|on|later|next|this|invite|remind|email)\b|$)/i,
  );

  if (aboutMatch?.[1]) {
    return toDisplayTitle(normalizeTitleCandidate(aboutMatch[1]));
  }

  return null;
}

function inferFallbackTitle(prompt: string) {
  if (/\bappointment\b/i.test(prompt)) {
    return "Scheduled Appointment";
  }

  if (/\b(call|phone call)\b/i.test(prompt) && !/\bmeeting\b/i.test(prompt)) {
    return "Scheduled Call";
  }

  return "Scheduled Meeting";
}

function extractSuggestedTitle(prompt: string) {
  const explicitTitle = extractQuotedTitle(prompt);

  if (explicitTitle) {
    return explicitTitle;
  }

  const contextualTitle = extractContextualTitle(prompt);

  if (contextualTitle && !isGenericTitleCandidate(contextualTitle)) {
    return contextualTitle;
  }

  return inferFallbackTitle(prompt);
}

function extractExplicitDurationMinutes(prompt: string) {
  const hourMinuteMatch = prompt.match(
    /\b(?:(\d+)\s*(?:hour|hours|hr|hrs))?(?:\s*(?:and)?\s*)?(?:(\d+)\s*(?:minute|minutes|min|mins))\b/i,
  );

  if (hourMinuteMatch) {
    const hours = Number(hourMinuteMatch[1] ?? 0);
    const minutes = Number(hourMinuteMatch[2] ?? 0);
    const totalMinutes = hours * 60 + minutes;

    if (totalMinutes >= 15 && totalMinutes <= 240) {
      return totalMinutes;
    }
  }

  const hourOnlyMatch = prompt.match(/\b(\d+)\s*(?:hour|hours|hr|hrs)\b/i);

  if (hourOnlyMatch) {
    const totalMinutes = Number(hourOnlyMatch[1]) * 60;

    if (totalMinutes >= 15 && totalMinutes <= 240) {
      return totalMinutes;
    }
  }

  const minuteOnlyMatch = prompt.match(/\b(\d+)\s*(?:minute|minutes|min|mins)\b/i);

  if (minuteOnlyMatch) {
    const totalMinutes = Number(minuteOnlyMatch[1]);

    if (totalMinutes >= 15 && totalMinutes <= 240) {
      return totalMinutes;
    }
  }

  return null;
}

function extractAttendeeEmails(prompt: string) {
  const matches = prompt.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];

  return [...new Set(matches.map((email) => email.toLowerCase()))];
}

function extractReminderMinutes(prompt: string) {
  const reminderClauses = [...prompt.matchAll(/\b(?:remind(?: me)?|reminded|reminder(?:s)?|alert(?: me)?)\b([^.!?\n]*)/gi)];
  const reminderMinutes: number[] = [];

  for (const match of reminderClauses) {
    const clause = normalizePromptText(match[1] ?? "");
    const beforeSegment = clause.split(/\bbefore\b/i)[0] ?? clause;

    if (!beforeSegment) {
      continue;
    }

    const hasHourUnit = /\b(?:hour|hours|hr|hrs)\b/i.test(beforeSegment);
    const hasMinuteUnit = /\b(?:minute|minutes|min|mins)\b/i.test(beforeSegment);

    if (hasHourUnit && hasMinuteUnit) {
      for (const unitMatch of beforeSegment.matchAll(
        /(\d{1,4})\s*(hour|hours|hr|hrs|minute|minutes|min|mins)\b/gi,
      )) {
        const amount = Number(unitMatch[1]);
        const unit = unitMatch[2].toLowerCase();

        reminderMinutes.push(unit.startsWith("h") ? amount * 60 : amount);
      }

      continue;
    }

    const rawNumbers = [...beforeSegment.matchAll(/\d{1,4}/g)].map((numberMatch) =>
      Number(numberMatch[0]),
    );

    if (!rawNumbers.length) {
      continue;
    }

    for (const amount of rawNumbers) {
      reminderMinutes.push(hasHourUnit ? amount * 60 : amount);
    }
  }

  return reminderMinutes.filter((minutes, index, values) => {
    return minutes > 0 && minutes <= 10080 && values.indexOf(minutes) === index;
  });
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
    attendeeEmails: extractAttendeeEmails(normalizedPrompt),
    explicitDurationMinutes: extractExplicitDurationMinutes(normalizedPrompt),
    preferredWindow: inferWindow(normalizedPrompt),
    priority: inferPriority(normalizedPrompt, timing),
    reminderMinutes: extractReminderMinutes(normalizedPrompt),
    suggestedTitle: extractSuggestedTitle(normalizedPrompt),
    timing,
  };
}

export { extractPromptDetails, normalizePromptText, toDisplayTitle };
export type { PromptDetails, PromptTiming, TimingMode };
