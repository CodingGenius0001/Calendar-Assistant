"use client";

import { startTransition, useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { VoiceIntake } from "@/components/voice-intake";
import type { UpcomingEvent } from "@/lib/google";
import {
  interpretTranscriptLocally,
  transcribeAudioLocally,
  type LocalIntakeResult,
} from "@/lib/local-intake";
import type { EventPriority, PreferredWindow } from "@/lib/scheduler";

type SessionSnapshot = {
  error: string | null;
  user: {
    email: string | null;
    image: string | null;
    name: string | null;
  };
} | null;

type DraftState = {
  durationMinutes: number;
  notes: string;
  preferredWindow: PreferredWindow;
  priority: EventPriority;
  timeZone: string;
  title: string;
};

type ScheduleResult = {
  eventLink?: string | null;
  rationale: string;
  slot: {
    bucket: "today" | "tomorrow" | "later";
    end: string;
    start: string;
    timeZone: string;
  };
  status: "previewed" | "booked";
  title: string;
};

type IntakeResult = LocalIntakeResult;

type DashboardShellProps = {
  calendarError: string | null;
  googleConfigured: boolean;
  session: SessionSnapshot;
  upcomingEvents: UpcomingEvent[];
};

const DRAFT_STORAGE_KEY = "calender-assistant-draft";

const PRIORITY_COPY: Array<{
  description: string;
  label: string;
  value: EventPriority;
}> = [
  {
    description: "Tries to land on the same day first.",
    label: "High",
    value: "high",
  },
  {
    description: "Starts with tomorrow, then checks the next few days.",
    label: "Medium",
    value: "medium",
  },
  {
    description: "Pushes into later dates before using near-term time.",
    label: "Low",
    value: "low",
  },
];

const WINDOW_COPY: Array<{
  description: string;
  label: string;
  value: PreferredWindow;
}> = [
  { description: "Use the best workday slot.", label: "Any time", value: "any" },
  { description: "Prefer the morning first.", label: "Morning", value: "morning" },
  {
    description: "Try to keep it after lunch.",
    label: "Afternoon",
    value: "afternoon",
  },
  { description: "Bias the schedule into the evening.", label: "Evening", value: "evening" },
];

function inferTitle(notes: string) {
  const cleanedNotes = notes.replace(/\s+/g, " ").trim();

  if (!cleanedNotes) {
    return "";
  }

  const candidate = cleanedNotes.split(" ").slice(0, 6).join(" ");
  return candidate.length > 42 ? `${candidate.slice(0, 39).trim()}...` : candidate;
}

function formatEventTime(event: UpcomingEvent, timeZone: string) {
  if (event.isAllDay) {
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      timeZone,
      weekday: "short",
    }).format(new Date(event.start));
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone,
    weekday: "short",
  }).format(new Date(event.start));
}

function formatSlotTime(dateIsoString: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone,
    weekday: "short",
  }).format(new Date(dateIsoString));
}

function formatIntakeEngine(engine: IntakeResult["engine"]) {
  return engine === "local-llm" ? "Local LLM" : "Fallback parser";
}

function sanitizeDraft(
  candidateDraft: Partial<DraftState>,
  timeZoneFallback: string,
): DraftState {
  return {
    durationMinutes:
      typeof candidateDraft.durationMinutes === "number" &&
      candidateDraft.durationMinutes >= 15 &&
      candidateDraft.durationMinutes <= 240
        ? candidateDraft.durationMinutes
        : 45,
    notes: typeof candidateDraft.notes === "string" ? candidateDraft.notes : "",
    preferredWindow:
      candidateDraft.preferredWindow === "morning" ||
      candidateDraft.preferredWindow === "afternoon" ||
      candidateDraft.preferredWindow === "evening"
        ? candidateDraft.preferredWindow
        : "any",
    priority:
      candidateDraft.priority === "medium" || candidateDraft.priority === "low"
        ? candidateDraft.priority
        : "high",
    timeZone:
      typeof candidateDraft.timeZone === "string" && candidateDraft.timeZone
        ? candidateDraft.timeZone
        : timeZoneFallback,
    title: typeof candidateDraft.title === "string" ? candidateDraft.title : "",
  };
}

export function DashboardShell({
  calendarError,
  googleConfigured,
  session,
  upcomingEvents,
}: DashboardShellProps) {
  const router = useRouter();
  const [draft, setDraft] = useState<DraftState>({
    durationMinutes: 45,
    notes: "",
    preferredWindow: "any",
    priority: "high",
    timeZone: "UTC",
    title: "",
  });
  const [hydrated, setHydrated] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [intakeResult, setIntakeResult] = useState<IntakeResult | null>(null);
  const [isIntakeBusy, setIsIntakeBusy] = useState(false);
  const [intakeStatus, setIntakeStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualPrompt, setManualPrompt] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [result, setResult] = useState<ScheduleResult | null>(null);

  useEffect(() => {
    const detectedTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    try {
      const savedDraft = window.localStorage.getItem(DRAFT_STORAGE_KEY);

      if (savedDraft) {
        const parsedDraft = JSON.parse(savedDraft) as Partial<DraftState>;
        setDraft(sanitizeDraft(parsedDraft, detectedTimeZone));
      } else {
        setDraft((currentDraft) => ({
          ...currentDraft,
          timeZone: detectedTimeZone,
        }));
      }
    } catch {
      setDraft((currentDraft) => ({
        ...currentDraft,
        timeZone: detectedTimeZone,
      }));
    }

    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }

    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(draft));
  }, [draft, hydrated]);

  function updateDraft<Key extends keyof DraftState>(
    key: Key,
    value: DraftState[Key],
  ) {
    setDraft((currentDraft) => ({
      ...currentDraft,
      [key]: value,
    }));
  }

  async function submitIntakeRequest(requestInit: {
    body: FormData | string;
  }) {
    setIsIntakeBusy(true);
    setIntakeError(null);
    setIntakeResult(null);
    setIntakeStatus(null);

    try {
      let transcript = "";

      if (requestInit.body instanceof FormData) {
        const audio = requestInit.body.get("audio");

        if (!(audio instanceof File) || audio.size === 0) {
          throw new Error("No audio file was uploaded.");
        }

        transcript = await transcribeAudioLocally(audio, setIntakeStatus);
      } else {
        const rawBody = JSON.parse(requestInit.body) as { text?: unknown };

        if (typeof rawBody.text !== "string" || !rawBody.text.trim()) {
          throw new Error("No text prompt was provided.");
        }

        transcript = rawBody.text.trim();
      }

      const payload = await interpretTranscriptLocally(transcript, setIntakeStatus);
      setIntakeResult(payload);
      setManualPrompt(payload.transcript);
    } catch (error) {
      setIntakeError(
        error instanceof Error
          ? error.message
          : "Local voice understanding failed.",
      );
    } finally {
      setIntakeStatus(null);
      setIsIntakeBusy(false);
    }
  }

  async function handleAudioReady(file: File) {
    const formData = new FormData();
    formData.append("audio", file, file.name);
    await submitIntakeRequest({ body: formData });
  }

  async function handleAnalyzeText() {
    const trimmedPrompt = manualPrompt.trim();

    if (!trimmedPrompt) {
      setIntakeError(
        "Add some prompt text before asking the local model to interpret it.",
      );
      return;
    }

    await submitIntakeRequest({
      body: JSON.stringify({ text: trimmedPrompt }),
    });
  }

  function resetIntake() {
    setIntakeError(null);
    setIntakeResult(null);
    setIntakeStatus(null);
    setManualPrompt("");
  }

  async function handleSchedule(
    mode: "preview" | "book",
    draftOverride?: DraftState,
  ) {
    const activeDraft = draftOverride ?? draft;
    const resolvedTitle = activeDraft.title.trim() || inferTitle(activeDraft.notes);

    if (!resolvedTitle.trim()) {
      setRequestError("Add a title or enough agenda notes so I can name the event.");
      return;
    }

    setIsSubmitting(true);
    setRequestError(null);

    try {
      const response = await fetch("/api/schedule", {
        body: JSON.stringify({
          clientNow: new Date().toISOString(),
          durationMinutes: activeDraft.durationMinutes,
          mode,
          notes: activeDraft.notes,
          preferredWindow: activeDraft.preferredWindow,
          priority: activeDraft.priority,
          timeZone: activeDraft.timeZone,
          title: resolvedTitle,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      const payload = (await response.json()) as
        | ScheduleResult
        | { error?: string };

      if (!response.ok || !("status" in payload)) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : "Scheduling failed.",
        );
      }

      setResult(payload);

      if (mode === "book") {
        startTransition(() => {
          router.refresh();
        });
      }
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Scheduling failed.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function approveInterpretation() {
    if (!intakeResult) {
      return;
    }

    const nextDraft: DraftState = {
      durationMinutes: intakeResult.interpretation.durationMinutes,
      notes: intakeResult.interpretation.notes,
      preferredWindow: intakeResult.interpretation.preferredWindow,
      priority: intakeResult.interpretation.priority,
      timeZone: draft.timeZone,
      title: intakeResult.interpretation.title,
    };

    setDraft((currentDraft) => ({
      ...currentDraft,
      ...nextDraft,
    }));
    await handleSchedule("preview", nextDraft);
  }

  if (!session) {
    return (
      <main className="soft-grid min-h-screen px-5 py-8 text-[var(--foreground)] md:px-10 md:py-10">
        <section className="glass-panel mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-6xl flex-col overflow-hidden rounded-[2rem] border">
          <div className="grid flex-1 gap-8 p-6 md:grid-cols-[1.2fr_0.8fr] md:p-10">
            <div className="flex flex-col justify-between gap-8">
              <div className="space-y-6">
                <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[rgba(17,32,51,0.12)] bg-[rgba(255,255,255,0.72)] px-4 py-2 text-sm font-medium text-[var(--muted)]">
                  <span className="inline-flex size-2 rounded-full bg-[var(--signal)]" />
                  Model-based voice calendar intake
                </div>
                <div className="space-y-4">
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                    Calender Assistant
                  </p>
                  <h1 className="display-font max-w-3xl text-5xl leading-none font-semibold tracking-tight md:text-7xl">
                    Speak the plan.
                    <br />
                    Confirm the intent.
                    <br />
                    Let the calendar place it.
                  </h1>
                  <p className="max-w-2xl text-lg leading-8 text-[var(--muted)]">
                    Voice prompts are transcribed with a local speech model, interpreted by
                    a local LLM, and shown back for approval before anything is scheduled.
                    Once approved, the app keeps going and finds the best calendar slot using
                    your priority rules.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-4">
                <button
                  className="rounded-full bg-[var(--button)] px-6 py-3 text-base font-semibold text-white transition hover:bg-[var(--button-hover)]"
                  onClick={() => signIn("google")}
                  type="button"
                >
                  Continue with Google
                </button>
                <a
                  className="rounded-full border border-[rgba(17,32,51,0.12)] px-6 py-3 text-base font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                  href="https://vercel.com/new"
                  rel="noreferrer"
                  target="_blank"
                >
                  Deploy on Vercel
                </a>
              </div>
              {!googleConfigured ? (
                <div className="rounded-[1.75rem] border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] p-5 text-sm leading-7 text-[var(--foreground)]">
                  Add the Google auth values from <code>.env.example</code> before sign-in
                  will work locally or on Vercel. The voice and intent models run in the
                  browser, so there is no paid AI API key to configure.
                </div>
              ) : null}
            </div>
            <div className="grid gap-4 md:grid-rows-[auto_auto_1fr]">
              <div className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-6">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                  Confirmation flow
                </p>
                <div className="mt-5 space-y-4">
                  <div className="rounded-3xl border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.75)] p-4">
                    <p className="font-semibold">1. Record</p>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                      Browser audio is transcribed by a local speech-to-text model.
                    </p>
                  </div>
                  <div className="rounded-3xl border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.75)] p-4">
                    <p className="font-semibold">2. Understand</p>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                      A local LLM extracts the calendar intent and falls back to a rules
                      parser if needed.
                    </p>
                  </div>
                  <div className="rounded-3xl border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.75)] p-4">
                    <p className="font-semibold">3. Confirm</p>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                      The app confirms the understanding and lets the user edit or re-record
                      before continuing.
                    </p>
                  </div>
                </div>
              </div>
              <div className="rounded-[1.75rem] border border-[var(--border)] bg-[rgba(21,93,82,0.12)] p-6">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--button)]">
                  No database required
                </p>
                <p className="mt-3 text-sm leading-7 text-[var(--foreground)]">
                  User separation comes from Google OAuth, and the current version writes
                  directly to each signed-in user&apos;s Google Calendar. That keeps the app
                  Vercel-friendly without adding a database.
                </p>
              </div>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="soft-grid min-h-screen px-4 py-5 text-[var(--foreground)] md:px-8 md:py-8">
      <div className="glass-panel mx-auto flex w-full max-w-7xl flex-col gap-6 rounded-[2rem] border p-4 md:p-6">
        <header className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-5 md:p-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="space-y-4">
              <div className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--surface-accent)] px-4 py-2 text-sm font-semibold text-[var(--button)]">
                <span className="inline-flex size-2 rounded-full bg-[var(--signal)]" />
                Google Calendar is connected
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                  Daily organizer
                </p>
                <h1 className="display-font mt-3 text-4xl leading-none font-semibold md:text-6xl">
                  {session.user.name ?? "Your"} schedule, understood before it is booked.
                </h1>
                <p className="mt-4 max-w-3xl text-base leading-7 text-[var(--muted)] md:text-lg">
                  Record a prompt, let the local model infer the calendar request, approve or
                  fix the understanding, then preview and book the slot into Google Calendar.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-full border border-[rgba(17,32,51,0.12)] bg-[rgba(255,255,255,0.72)] px-4 py-2 text-sm text-[var(--muted)]">
                {session.user.email ?? "Google account"}
              </div>
              <button
                className="rounded-full border border-[rgba(17,32,51,0.12)] px-4 py-2 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                onClick={() => signOut({ callbackUrl: "/" })}
                type="button"
              >
                Sign out
              </button>
            </div>
          </div>
          {session.error ? (
            <div className="mt-5 rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
              Your Google token needs to be refreshed. Sign out and reconnect if calendar
              reads start failing.
            </div>
          ) : null}
        </header>
        <div className="grid gap-6 lg:grid-cols-[1.12fr_0.88fr]">
          <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-5 md:p-6">
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                    Voice to action
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold">Capture, confirm, schedule</h2>
                </div>
                <div className="rounded-full border border-[rgba(17,32,51,0.12)] bg-[rgba(255,255,255,0.72)] px-4 py-2 text-sm text-[var(--muted)]">
                  Time zone: {draft.timeZone}
                </div>
              </div>

              <VoiceIntake
                disabled={isIntakeBusy}
                isBusy={isIntakeBusy}
                onAudioReady={handleAudioReady}
              />

              <div className="rounded-3xl border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.72)] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
                Speech-to-text and intent parsing run in the browser, so GitHub pushes and
                Vercel deploys do not need a paid AI secret. The first run downloads the
                models, and if the local LLM cannot start the built-in parser takes over.
                {intakeStatus ? (
                  <p className="mt-2 font-semibold text-[var(--foreground)]">
                    {intakeStatus}
                  </p>
                ) : null}
              </div>

              <div className="field-shell rounded-[1.5rem] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    Editable prompt text
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="text-sm font-semibold text-[var(--button)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isIntakeBusy}
                      onClick={handleAnalyzeText}
                      type="button"
                    >
                      {isIntakeBusy ? "Analyzing..." : "Analyze typed prompt"}
                    </button>
                    <button
                      className="text-sm font-semibold text-[var(--muted)]"
                      onClick={resetIntake}
                      type="button"
                    >
                      Re-record / reset
                    </button>
                  </div>
                </div>
                <textarea
                  className="mt-3 min-h-32 w-full resize-none bg-transparent text-base leading-7 outline-none"
                  onChange={(event) => setManualPrompt(event.target.value)}
                  placeholder="Type here if you want to fix the transcript before asking the LLM to interpret it again."
                  value={manualPrompt}
                />
              </div>

              {intakeError ? (
                <div className="rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  {intakeError}
                </div>
              ) : null}

              {intakeResult ? (
                <div className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-5">
                  <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    Interpreted understanding
                  </p>
                  <div className="mt-4 rounded-[1.5rem] bg-[rgba(21,93,82,0.08)] p-4">
                    <p className="text-sm leading-7 text-[var(--foreground)]">
                      {intakeResult.interpretation.userConfirmationMessage}
                    </p>
                  </div>
                  <div className="mt-4 grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                    <div className="rounded-[1.5rem] bg-[rgba(17,32,51,0.04)] p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                        Transcript
                      </p>
                      <p className="mt-3 text-sm leading-7 text-[var(--foreground)]">
                        {intakeResult.transcript}
                      </p>
                    </div>
                    <div className="rounded-[1.5rem] bg-[rgba(255,255,255,0.8)] p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                        Parsed intent
                      </p>
                      <div className="mt-3 space-y-2 text-sm leading-6 text-[var(--foreground)]">
                        <p>
                          <span className="font-semibold">Engine:</span>{" "}
                          {formatIntakeEngine(intakeResult.engine)}
                        </p>
                        <p>
                          <span className="font-semibold">Title:</span>{" "}
                          {intakeResult.interpretation.title}
                        </p>
                        <p>
                          <span className="font-semibold">Priority:</span>{" "}
                          {intakeResult.interpretation.priority}
                        </p>
                        <p>
                          <span className="font-semibold">Duration:</span>{" "}
                          {intakeResult.interpretation.durationMinutes} minutes
                        </p>
                        <p>
                          <span className="font-semibold">Window:</span>{" "}
                          {intakeResult.interpretation.preferredWindow}
                        </p>
                        <p>
                          <span className="font-semibold">Timing cue:</span>{" "}
                          {intakeResult.interpretation.requestedDateLabel}
                        </p>
                        <p>
                          <span className="font-semibold">Confidence:</span>{" "}
                          {intakeResult.interpretation.confidence}
                        </p>
                      </div>
                    </div>
                  </div>
                  {intakeResult.interpretation.needsClarification ? (
                    <div className="mt-4 rounded-3xl border border-[rgba(216,140,65,0.2)] bg-[rgba(216,140,65,0.12)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                      The current interpretation looks uncertain. Edit the text or re-record
                      if the summary looks off.
                    </div>
                  ) : null}
                  <div className="mt-4 flex flex-wrap gap-3">
                    <button
                      className="rounded-full bg-[var(--button)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--button-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isSubmitting}
                      onClick={approveInterpretation}
                      type="button"
                    >
                      Approve and continue
                    </button>
                    <button
                      className="rounded-full border border-[rgba(17,32,51,0.12)] px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isIntakeBusy}
                      onClick={handleAnalyzeText}
                      type="button"
                    >
                      Re-analyze edited text
                    </button>
                    <button
                      className="rounded-full border border-[rgba(17,32,51,0.12)] px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                      onClick={resetIntake}
                      type="button"
                    >
                      Re-record prompt
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="field-shell rounded-[1.5rem] p-4">
                <label className="flex flex-col gap-2">
                  <span className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    Event title
                  </span>
                  <input
                    className="bg-transparent text-lg outline-none"
                    onChange={(event) => updateDraft("title", event.target.value)}
                    placeholder="Team sync, study block, dentist, grocery run..."
                    value={draft.title}
                  />
                </label>
              </div>

              <div className="field-shell rounded-[1.5rem] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    Agenda notes
                  </span>
                  <button
                    className="text-sm font-semibold text-[var(--button)]"
                    onClick={() => updateDraft("notes", "")}
                    type="button"
                  >
                    Clear
                  </button>
                </div>
                <textarea
                  className="mt-3 min-h-40 w-full resize-none bg-transparent text-base leading-7 outline-none"
                  onChange={(event) => updateDraft("notes", event.target.value)}
                  placeholder="This is the confirmed or manually edited event detail that will be used for scheduling."
                  value={draft.notes}
                />
              </div>

              <div className="grid gap-4 md:grid-cols-[0.9fr_1.1fr]">
                <div className="field-shell rounded-[1.5rem] p-4">
                  <label className="flex flex-col gap-3">
                    <span className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                      Duration
                    </span>
                    <input
                      className="bg-transparent text-3xl font-semibold outline-none"
                      max={240}
                      min={15}
                      onChange={(event) =>
                        updateDraft(
                          "durationMinutes",
                          Number(event.target.value) || 15,
                        )
                      }
                      step={15}
                      type="number"
                      value={draft.durationMinutes}
                    />
                    <span className="text-sm text-[var(--muted)]">Minutes</span>
                  </label>
                </div>

                <div className="grid gap-3">
                  <div className="rounded-[1.5rem] border border-[var(--border)] bg-[rgba(255,255,255,0.68)] p-4">
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                      Priority
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      {PRIORITY_COPY.map((priority) => {
                        const selected = draft.priority === priority.value;

                        return (
                          <button
                            className={`rounded-2xl border px-4 py-3 text-left transition ${
                              selected
                                ? "border-[var(--button)] bg-[rgba(21,93,82,0.1)]"
                                : "border-[rgba(17,32,51,0.08)] bg-white/70 hover:bg-white"
                            }`}
                            key={priority.value}
                            onClick={() => updateDraft("priority", priority.value)}
                            type="button"
                          >
                            <p className="font-semibold">{priority.label}</p>
                            <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                              {priority.description}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-[1.5rem] border border-[var(--border)] bg-[rgba(255,255,255,0.68)] p-4">
                    <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                      Preferred window
                    </p>
                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                      {WINDOW_COPY.map((windowOption) => {
                        const selected = draft.preferredWindow === windowOption.value;

                        return (
                          <button
                            className={`rounded-2xl border px-4 py-3 text-left transition ${
                              selected
                                ? "border-[var(--signal)] bg-[rgba(216,140,65,0.12)]"
                                : "border-[rgba(17,32,51,0.08)] bg-white/70 hover:bg-white"
                            }`}
                            key={windowOption.value}
                            onClick={() =>
                              updateDraft("preferredWindow", windowOption.value)
                            }
                            type="button"
                          >
                            <p className="font-semibold">{windowOption.label}</p>
                            <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                              {windowOption.description}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {requestError ? (
                <div className="rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  {requestError}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-full border border-[rgba(17,32,51,0.12)] bg-white px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(255,255,255,0.84)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSubmitting || !googleConfigured}
                  onClick={() => handleSchedule("preview")}
                  type="button"
                >
                  {isSubmitting ? "Finding a slot..." : "Preview best slot"}
                </button>
                <button
                  className="rounded-full bg-[var(--button)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--button-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSubmitting || !googleConfigured}
                  onClick={() => handleSchedule("book")}
                  type="button"
                >
                  {isSubmitting ? "Booking..." : "Book on Google Calendar"}
                </button>
              </div>
            </div>
          </section>

          <aside className="grid gap-6">
            <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-5 md:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                Scheduling logic
              </p>
              <div className="mt-4 space-y-3">
                <div className="rounded-3xl bg-[rgba(21,93,82,0.08)] p-4">
                  <p className="font-semibold">High priority</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    Searches today first and then falls forward to the next open slot if
                    today is full.
                  </p>
                </div>
                <div className="rounded-3xl bg-[rgba(216,140,65,0.12)] p-4">
                  <p className="font-semibold">Medium priority</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    Starts tomorrow and checks the following few days before moving farther.
                  </p>
                </div>
                <div className="rounded-3xl bg-[rgba(17,32,51,0.06)] p-4">
                  <p className="font-semibold">Low priority</p>
                  <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                    Pushes the work out later in the week to protect short-term calendar
                    space.
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-5 md:p-6">
              <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                Recommendation
              </p>
              {result ? (
                <div className="mt-4 space-y-4">
                  <div className="rounded-[1.5rem] bg-[rgba(255,255,255,0.78)] p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                      {result.status === "booked" ? "Booked event" : "Previewed slot"}
                    </p>
                    <h3 className="mt-2 text-2xl font-semibold">{result.title}</h3>
                    <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                      {formatSlotTime(result.slot.start, result.slot.timeZone)} to{" "}
                      {formatSlotTime(result.slot.end, result.slot.timeZone)}
                    </p>
                    <span className="mt-4 inline-flex rounded-full bg-[var(--surface-accent)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--button)]">
                      {result.slot.bucket}
                    </span>
                  </div>
                  <p className="rounded-[1.5rem] bg-[rgba(17,32,51,0.04)] p-4 text-sm leading-7 text-[var(--foreground)]">
                    {result.rationale}
                  </p>
                  {result.eventLink ? (
                    <a
                      className="inline-flex w-fit rounded-full border border-[rgba(17,32,51,0.12)] px-4 py-2 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                      href={result.eventLink}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open in Google Calendar
                    </a>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 rounded-[1.5rem] bg-[rgba(17,32,51,0.04)] p-4 text-sm leading-7 text-[var(--muted)]">
                  After the user approves the interpreted prompt, the app previews the best
                  slot here. The user can still edit details and book the final event.
                </div>
              )}
            </section>

            <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-5 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                    Upcoming calendar
                  </p>
                  <p className="mt-1 text-sm text-[var(--muted)]">
                    Pulled from your Google Calendar.
                  </p>
                </div>
                {hydrated ? (
                  <span className="rounded-full bg-[rgba(255,255,255,0.8)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    {draft.timeZone}
                  </span>
                ) : null}
              </div>
              {calendarError ? (
                <div className="mt-4 rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  {calendarError}
                </div>
              ) : null}
              <div className="mt-4 space-y-3">
                {upcomingEvents.length ? (
                  upcomingEvents.map((event) => (
                    <div
                      className="rounded-[1.5rem] border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.76)] p-4"
                      key={event.id}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">{event.summary}</p>
                          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                            {formatEventTime(event, draft.timeZone)}
                          </p>
                        </div>
                        {event.htmlLink ? (
                          <a
                            className="text-sm font-semibold text-[var(--button)]"
                            href={event.htmlLink}
                            rel="noreferrer"
                            target="_blank"
                          >
                            Open
                          </a>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-[1.5rem] bg-[rgba(17,32,51,0.04)] p-4 text-sm leading-7 text-[var(--muted)]">
                    No upcoming events were found on the connected Google Calendar.
                  </div>
                )}
              </div>
            </section>
          </aside>
        </div>
      </div>
    </main>
  );
}
