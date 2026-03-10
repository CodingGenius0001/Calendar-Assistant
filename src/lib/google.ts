import { google } from "googleapis";

type UpcomingEvent = {
  end: string;
  htmlLink: string | null;
  id: string;
  isAllDay: boolean;
  start: string;
  summary: string;
};

type CreateCalendarEventInput = {
  attendeeEmails: string[];
  end: Date;
  notes: string;
  reminderMinutes: number[];
  start: Date;
  timeZone: string;
  title: string;
};

function getCalendarClient(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });

  return google.calendar({
    auth,
    version: "v3",
  });
}

function buildEventDescription(notes: string) {
  const cleanedNotes = notes.trim();

  if (!cleanedNotes) {
    return "Scheduled by Calendar Assistant.";
  }

  return `Scheduled by Calendar Assistant.\n\nAgenda notes:\n${cleanedNotes}`;
}

export async function listUpcomingEvents(accessToken: string): Promise<UpcomingEvent[]> {
  const calendar = getCalendarClient(accessToken);
  const response = await calendar.events.list({
    calendarId: "primary",
    maxResults: 6,
    orderBy: "startTime",
    singleEvents: true,
    timeMin: new Date().toISOString(),
  });

  return (response.data.items ?? [])
    .filter((event) => Boolean(event.id) && Boolean(event.start?.dateTime ?? event.start?.date))
    .map((event) => ({
      end: event.end?.dateTime ?? event.end?.date ?? "",
      htmlLink: event.htmlLink ?? null,
      id: event.id ?? crypto.randomUUID(),
      isAllDay: Boolean(event.start?.date && !event.start?.dateTime),
      start: event.start?.dateTime ?? event.start?.date ?? "",
      summary: event.summary ?? "Untitled event",
    }));
}

export async function listBusyBlocks(
  accessToken: string,
  timeMin: Date,
  timeMax: Date,
  timeZone: string,
) {
  const calendar = getCalendarClient(accessToken);
  const response = await calendar.freebusy.query({
    requestBody: {
      items: [{ id: "primary" }],
      timeMax: timeMax.toISOString(),
      timeMin: timeMin.toISOString(),
      timeZone,
    },
  });

  return (response.data.calendars?.primary?.busy ?? [])
    .filter((entry) => Boolean(entry.start) && Boolean(entry.end))
    .map((entry) => ({
      end: new Date(entry.end ?? ""),
      start: new Date(entry.start ?? ""),
    }));
}

export async function createCalendarEvent(
  accessToken: string,
  input: CreateCalendarEventInput,
) {
  const calendar = getCalendarClient(accessToken);
  const reminderOverrides = input.reminderMinutes.map((minutes) => ({
    method: "popup" as const,
    minutes,
  }));
  const reminders =
    reminderOverrides.length > 0
      ? {
          overrides: reminderOverrides,
          useDefault: false,
        }
      : {
          useDefault: true,
        };
  const response = await calendar.events.insert({
    calendarId: "primary",
    conferenceDataVersion: 1,
    requestBody: {
      attendees: input.attendeeEmails.map((email) => ({ email })),
      conferenceData: {
        createRequest: {
          conferenceSolutionKey: {
            type: "hangoutsMeet",
          },
          requestId: crypto.randomUUID(),
        },
      },
      description: buildEventDescription(input.notes),
      end: {
        dateTime: input.end.toISOString(),
        timeZone: input.timeZone,
      },
      reminders,
      start: {
        dateTime: input.start.toISOString(),
        timeZone: input.timeZone,
      },
      summary: input.title,
    },
    sendUpdates: input.attendeeEmails.length > 0 ? "all" : "none",
  });

  return {
    htmlLink: response.data.htmlLink ?? null,
    id: response.data.id ?? crypto.randomUUID(),
  };
}

export type { UpcomingEvent };
