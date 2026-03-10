import { addDays, addMinutes } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";

type EventPriority = "high" | "medium" | "low";
type PreferredWindow = "any" | "morning" | "afternoon" | "evening";
type TimingMode = "exact" | "day" | "flexible";

type BusyBlock = {
  end: Date;
  start: Date;
};

type ScheduleInput = {
  durationMinutes: number;
  now: Date;
  preferredWindow: PreferredWindow;
  priority: EventPriority;
  requestedDateKey?: string | null;
  requestedStart?: Date | null;
  timingMode: TimingMode;
  timeZone: string;
};

type ScheduledSlot = {
  bucket: "today" | "tomorrow" | "later";
  end: Date;
  matchType: "requested" | "adjusted" | "recommended" | "selected";
  rationale: string;
  start: Date;
};

type SlotOption = {
  bucket: "today" | "tomorrow" | "later";
  end: Date;
  start: Date;
};

type WindowDefinition = {
  endHour: number;
  label: string;
  startHour: number;
};

const PRIORITY_RULES: Record<
  EventPriority,
  {
    idealLabel: string;
    offsets: number[];
    summary: string;
  }
> = {
  high: {
    idealLabel: "today",
    offsets: [0, 1],
    summary: "High priority checks today first, then falls back to the next open slot.",
  },
  low: {
    idealLabel: "later this week",
    offsets: [2, 3, 4, 5, 6, 7],
    summary: "Low priority intentionally pushes into later dates before using near-term time.",
  },
  medium: {
    idealLabel: "tomorrow",
    offsets: [1, 2, 3],
    summary: "Medium priority starts with tomorrow and then searches the next few days.",
  },
};

const WINDOW_RULES: Record<PreferredWindow, WindowDefinition[]> = {
  any: [{ endHour: 18, label: "the workday", startHour: 9 }],
  afternoon: [
    { endHour: 17, label: "the afternoon", startHour: 12 },
    { endHour: 12, label: "the morning", startHour: 8 },
    { endHour: 20, label: "the evening", startHour: 17 },
  ],
  evening: [
    { endHour: 20, label: "the evening", startHour: 17 },
    { endHour: 17, label: "the afternoon", startHour: 12 },
  ],
  morning: [
    { endHour: 12, label: "the morning", startHour: 8 },
    { endHour: 18, label: "later in the day", startHour: 12 },
  ],
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function buildZonedDate(dateKey: string, hour: number, minute: number, timeZone: string) {
  return fromZonedTime(
    `${dateKey}T${pad(hour)}:${pad(minute)}:00`,
    timeZone,
  );
}

function getLocalDateKey(date: Date, timeZone: string) {
  return formatInTimeZone(date, timeZone, "yyyy-MM-dd");
}

function roundUpToQuarterHour(date: Date) {
  const quarterHour = 15 * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / quarterHour) * quarterHour);
}

function formatClockTime(date: Date, timeZone: string) {
  return formatInTimeZone(date, timeZone, "h:mm a");
}

function overlapsBusyBlock(start: Date, end: Date, busyBlocks: BusyBlock[]) {
  return busyBlocks.some(
    (busyBlock) => start < busyBlock.end && end > busyBlock.start,
  );
}

function isSlotAvailable(
  start: Date,
  durationMinutes: number,
  now: Date,
  busyBlocks: BusyBlock[],
) {
  const end = addMinutes(start, durationMinutes);

  if (start < now) {
    return false;
  }

  return !overlapsBusyBlock(start, end, busyBlocks);
}

function getDayOffsetFromDateKey(dateKey: string, now: Date, timeZone: string) {
  const todayKey = getLocalDateKey(now, timeZone);
  const todayAnchor = buildZonedDate(todayKey, 12, 0, timeZone);
  const targetAnchor = buildZonedDate(dateKey, 12, 0, timeZone);
  return Math.round(
    (targetAnchor.getTime() - todayAnchor.getTime()) / (24 * 60 * 60 * 1000),
  );
}

function describeBucket(dayOffset: number): "today" | "tomorrow" | "later" {
  if (dayOffset <= 0) {
    return "today";
  }

  if (dayOffset === 1) {
    return "tomorrow";
  }

  return "later";
}

function buildRationale(
  priority: EventPriority,
  dayOffset: number,
  preferredWindow: PreferredWindow,
  matchedWindow: WindowDefinition,
) {
  const priorityRule = PRIORITY_RULES[priority];
  const bucket = describeBucket(dayOffset);

  const placementLine =
    priority === "high" && dayOffset > 0
      ? "No same-day opening fit, so I used the next earliest spot."
      : priority === "medium" && bucket !== "tomorrow"
        ? "Tomorrow was packed, so I shifted to the next available day."
        : priority === "low" && bucket !== "later"
          ? "A later-week slot was not available, so I used the earliest fallback."
          : `This lands in ${priorityRule.idealLabel}, which matches the ${priority} priority rule.`;

  const windowLine =
    preferredWindow === "any"
      ? `It fits cleanly inside ${matchedWindow.label}.`
      : matchedWindow.label === preferredWindow
        ? `It stays inside your preferred ${preferredWindow} window.`
        : `Your preferred ${preferredWindow} window was full, so I used ${matchedWindow.label}.`;

  return `${priorityRule.summary} ${placementLine} ${windowLine}`;
}

function findSlotOnDate(
  input: Pick<ScheduleInput, "durationMinutes" | "now" | "preferredWindow" | "timeZone">,
  busyBlocks: BusyBlock[],
  dateKey: string,
  rationaleBuilder: (matchedWindow: WindowDefinition) => string,
) {
  const busyBlocksSorted = [...busyBlocks].sort(
    (left, right) => left.start.getTime() - right.start.getTime(),
  );
  const windows = WINDOW_RULES[input.preferredWindow];
  const dayOffset = getDayOffsetFromDateKey(dateKey, input.now, input.timeZone);

  for (const matchedWindow of windows) {
    const windowStart = buildZonedDate(
      dateKey,
      matchedWindow.startHour,
      0,
      input.timeZone,
    );
    const windowEnd = buildZonedDate(
      dateKey,
      matchedWindow.endHour,
      0,
      input.timeZone,
    );

    let cursor = roundUpToQuarterHour(windowStart);
    if (dayOffset === 0 && cursor < input.now) {
      cursor = roundUpToQuarterHour(input.now);
    }

    while (addMinutes(cursor, input.durationMinutes) <= windowEnd) {
      const slotEnd = addMinutes(cursor, input.durationMinutes);

      if (!overlapsBusyBlock(cursor, slotEnd, busyBlocksSorted)) {
        return {
          bucket: describeBucket(dayOffset),
          end: slotEnd,
          matchType: "recommended" as const,
          rationale: rationaleBuilder(matchedWindow),
          start: cursor,
        };
      }

      cursor = addMinutes(cursor, 15);
    }
  }

  return null;
}

export function buildSearchRange(input: Pick<ScheduleInput, "now" | "priority" | "timeZone">) {
  const offsets = PRIORITY_RULES[input.priority].offsets;
  const anchorDay = getLocalDateKey(input.now, input.timeZone);
  const anchorNoon = buildZonedDate(anchorDay, 12, 0, input.timeZone);
  const firstDate = getLocalDateKey(
    addDays(anchorNoon, offsets[0]),
    input.timeZone,
  );
  const lastDate = getLocalDateKey(
    addDays(anchorNoon, offsets[offsets.length - 1]),
    input.timeZone,
  );

  return {
    timeMax: buildZonedDate(lastDate, 23, 59, input.timeZone),
    timeMin: buildZonedDate(firstDate, 0, 0, input.timeZone),
  };
}

export function buildExactSearchRange(requestedStart: Date, timeZone: string) {
  const requestedDateKey = getLocalDateKey(requestedStart, timeZone);

  return {
    timeMax: buildZonedDate(requestedDateKey, 23, 59, timeZone),
    timeMin: buildZonedDate(requestedDateKey, 0, 0, timeZone),
  };
}

export function buildRequestedDaySearchRange(requestedDateKey: string, timeZone: string) {
  return {
    timeMax: buildZonedDate(requestedDateKey, 23, 59, timeZone),
    timeMin: buildZonedDate(requestedDateKey, 0, 0, timeZone),
  };
}

export function buildSelectedSlot(
  input: Pick<ScheduleInput, "durationMinutes" | "now" | "timeZone"> & {
    requestedStart?: Date | null;
    selectedStart: Date;
  },
  busyBlocks: BusyBlock[],
): ScheduledSlot | null {
  if (
    !isSlotAvailable(
      input.selectedStart,
      input.durationMinutes,
      input.now,
      busyBlocks,
    )
  ) {
    return null;
  }

  const selectedDateKey = getLocalDateKey(input.selectedStart, input.timeZone);
  const dayOffset = getDayOffsetFromDateKey(
    selectedDateKey,
    input.now,
    input.timeZone,
  );
  const pickedRequestedTime =
    input.requestedStart &&
    input.requestedStart.getTime() === input.selectedStart.getTime();

  return {
    bucket: describeBucket(dayOffset),
    end: addMinutes(input.selectedStart, input.durationMinutes),
    matchType: pickedRequestedTime ? "requested" : "selected",
    rationale: pickedRequestedTime
      ? "This matches the time you chose."
      : `You picked another open time at ${formatClockTime(input.selectedStart, input.timeZone)}.`,
    start: input.selectedStart,
  };
}

export function findAlternativeSlots(
  input: Pick<ScheduleInput, "durationMinutes" | "now" | "timeZone">,
  busyBlocks: BusyBlock[],
  dateKey: string,
  startAfter: Date,
  limit = 4,
): SlotOption[] {
  const results: SlotOption[] = [];
  const busyBlocksSorted = [...busyBlocks].sort(
    (left, right) => left.start.getTime() - right.start.getTime(),
  );
  const sameDayEnd = buildZonedDate(dateKey, 23, 59, input.timeZone);
  const dayOffset = getDayOffsetFromDateKey(dateKey, input.now, input.timeZone);
  let cursor = roundUpToQuarterHour(startAfter);

  while (
    results.length < limit &&
    addMinutes(cursor, input.durationMinutes) <= sameDayEnd
  ) {
    const end = addMinutes(cursor, input.durationMinutes);

    if (!overlapsBusyBlock(cursor, end, busyBlocksSorted)) {
      results.push({
        bucket: describeBucket(dayOffset),
        end,
        start: cursor,
      });
    }

    cursor = addMinutes(cursor, 15);
  }

  return results;
}

export function findAvailableSlot(
  input: ScheduleInput,
  busyBlocks: BusyBlock[],
): ScheduledSlot | null {
  if (input.timingMode === "exact" && input.requestedStart) {
    const requestedDateKey = getLocalDateKey(input.requestedStart, input.timeZone);
    const slotEnd = addMinutes(input.requestedStart, input.durationMinutes);

    if (
      input.requestedStart >= input.now &&
      !overlapsBusyBlock(input.requestedStart, slotEnd, busyBlocks)
    ) {
      const dayOffset = getDayOffsetFromDateKey(
        requestedDateKey,
        input.now,
        input.timeZone,
      );

      return {
        bucket: describeBucket(dayOffset),
        end: slotEnd,
        matchType: "requested",
        rationale: "This matches the exact time you asked for.",
        start: input.requestedStart,
      };
    }

    const sameDayEnd = buildZonedDate(requestedDateKey, 23, 59, input.timeZone);
    let cursor = roundUpToQuarterHour(
      input.requestedStart > input.now ? input.requestedStart : input.now,
    );

    while (addMinutes(cursor, input.durationMinutes) <= sameDayEnd) {
      const alternativeEnd = addMinutes(cursor, input.durationMinutes);

      if (!overlapsBusyBlock(cursor, alternativeEnd, busyBlocks)) {
        const dayOffset = getDayOffsetFromDateKey(
          requestedDateKey,
          input.now,
          input.timeZone,
        );
        const rationale =
          input.requestedStart < input.now
            ? `The original time has already passed, so I suggested the next open slot at ${formatClockTime(cursor, input.timeZone)} on the same day.`
            : `${formatClockTime(input.requestedStart, input.timeZone)} was busy, so I suggested the next open slot at ${formatClockTime(cursor, input.timeZone)} on the same day.`;

        return {
          bucket: describeBucket(dayOffset),
          end: alternativeEnd,
          matchType: "adjusted",
          rationale,
          start: cursor,
        };
      }

      cursor = addMinutes(cursor, 15);
    }

    return null;
  }

  if (input.timingMode === "day" && input.requestedDateKey) {
    return findSlotOnDate(
      input,
      busyBlocks,
      input.requestedDateKey,
      () =>
        "You asked for a specific day, so I searched that day first and used the earliest opening that fit.",
    );
  }

  const priorityRule = PRIORITY_RULES[input.priority];
  const todayLocalKey = getLocalDateKey(input.now, input.timeZone);
  const anchorNoon = buildZonedDate(todayLocalKey, 12, 0, input.timeZone);

  for (const dayOffset of priorityRule.offsets) {
    const dateKey = getLocalDateKey(addDays(anchorNoon, dayOffset), input.timeZone);
    const flexibleSlot = findSlotOnDate(
      input,
      busyBlocks,
      dateKey,
      (matchedWindow) =>
        buildRationale(
          input.priority,
          dayOffset,
          input.preferredWindow,
          matchedWindow,
        ),
    );

    if (flexibleSlot) {
      return flexibleSlot;
    }
  }

  return null;
}

export { getLocalDateKey };
export type {
  BusyBlock,
  EventPriority,
  PreferredWindow,
  ScheduledSlot,
  SlotOption,
  TimingMode,
};
