"use client";

import { startTransition, useEffect, useState } from "react";
import { signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";
import { VoiceIntake } from "@/components/voice-intake";
import {
  interpretTranscriptLocally,
  transcribeAudioLocally,
  type LocalIntakeResult,
} from "@/lib/local-intake";
import type { PromptTiming } from "@/lib/prompt-details";
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
  attendeeEmails: string[];
  durationMinutes: number;
  notes: string;
  preferredWindow: PreferredWindow;
  priority: EventPriority;
  promptTiming: PromptTiming;
  reminderMinutes: number[];
  timeZone: string;
  title: string;
};

type FlowStep = "record" | "review" | "recommend";

type ScheduleResult = {
  eventLink?: string | null;
  matchType: "requested" | "adjusted" | "recommended";
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

type DashboardShellProps = {
  googleConfigured: boolean;
  session: SessionSnapshot;
};

function createEmptyTiming(): PromptTiming {
  return {
    mode: "flexible",
    requestedDateKey: null,
    requestedDateLabel: "best available time",
    requestedStartIso: null,
    requestedTimeLabel: null,
  };
}

function createInitialDraft(timeZone: string): DraftState {
  return {
    attendeeEmails: [],
    durationMinutes: 30,
    notes: "",
    preferredWindow: "any",
    priority: "medium",
    promptTiming: createEmptyTiming(),
    reminderMinutes: [],
    timeZone,
    title: "",
  };
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

function formatIntakeEngine(engine: LocalIntakeResult["engine"]) {
  return engine === "local-llm" ? "Local LLM" : "Fallback parser";
}

function formatTimingSummary(timing: PromptTiming) {
  if (timing.mode === "exact") {
    return timing.requestedDateLabel;
  }

  if (timing.mode === "day") {
    return timing.requestedDateLabel;
  }

  return "Flexible timing";
}

function formatDurationSummary(durationMinutes: number) {
  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  return `${durationMinutes} minutes`;
}

function formatReminderSummary(reminderMinutes: number[]) {
  if (!reminderMinutes.length) {
    return "Default reminders";
  }

  return [...reminderMinutes]
    .sort((left, right) => right - left)
    .map((minutes) => `${formatDurationSummary(minutes)} before`)
    .join(", ");
}

function StepMarker({
  active,
  label,
  stepNumber,
}: {
  active: boolean;
  label: string;
  stepNumber: number;
}) {
  return (
    <div
      className={`rounded-full px-3 py-2 text-xs font-semibold uppercase tracking-[0.2em] transition ${
        active
          ? "bg-[var(--button)] text-white"
          : "bg-[rgba(255,255,255,0.76)] text-[var(--muted)]"
      }`}
    >
      {stepNumber}. {label}
    </div>
  );
}

export function DashboardShell({ googleConfigured, session }: DashboardShellProps) {
  const router = useRouter();
  const [step, setStep] = useState<FlowStep>("record");
  const [draft, setDraft] = useState<DraftState>(() => createInitialDraft("UTC"));
  const [intakeError, setIntakeError] = useState<string | null>(null);
  const [intakeResult, setIntakeResult] = useState<LocalIntakeResult | null>(null);
  const [intakeStatus, setIntakeStatus] = useState<string | null>(null);
  const [isIntakeBusy, setIsIntakeBusy] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [manualPrompt, setManualPrompt] = useState("");
  const [requestError, setRequestError] = useState<string | null>(null);
  const [result, setResult] = useState<ScheduleResult | null>(null);

  useEffect(() => {
    const detectedTimeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

    setDraft((currentDraft) => ({
      ...currentDraft,
      timeZone: detectedTimeZone,
    }));
  }, []);

  function resetFlow() {
    setDraft(createInitialDraft(draft.timeZone));
    setIntakeError(null);
    setIntakeResult(null);
    setIntakeStatus(null);
    setManualPrompt("");
    setRequestError(null);
    setResult(null);
    setStep("record");
  }

  async function submitIntakeRequest(requestInit: {
    body: FormData | string;
  }) {
    setIsIntakeBusy(true);
    setIntakeError(null);
    setIntakeResult(null);
    setIntakeStatus(null);
    setRequestError(null);
    setResult(null);

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

      const payload = await interpretTranscriptLocally(
        transcript,
        {
          now: new Date(),
          timeZone: draft.timeZone,
        },
        setIntakeStatus,
      );

      setIntakeResult(payload);
      setManualPrompt(payload.transcript);
      setStep("review");
    } catch (error) {
      setIntakeError(
        error instanceof Error ? error.message : "Voice understanding failed.",
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
      setIntakeError("Add some prompt text before continuing.");
      return;
    }

    await submitIntakeRequest({
      body: JSON.stringify({ text: trimmedPrompt }),
    });
  }

  async function handleSchedule(
    mode: "preview" | "book",
    draftOverride?: DraftState,
  ) {
    const activeDraft = draftOverride ?? draft;

    setIsSubmitting(true);
    setRequestError(null);

    try {
      const response = await fetch("/api/schedule", {
        body: JSON.stringify({
          attendeeEmails: activeDraft.attendeeEmails,
          clientNow: new Date().toISOString(),
          durationMinutes: activeDraft.durationMinutes,
          mode,
          notes: activeDraft.notes,
          preferredWindow: activeDraft.preferredWindow,
          priority: activeDraft.priority,
          promptTiming: activeDraft.promptTiming,
          reminderMinutes: activeDraft.reminderMinutes,
          timeZone: activeDraft.timeZone,
          title: activeDraft.title,
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

      return payload;
    } catch (error) {
      setRequestError(
        error instanceof Error ? error.message : "Scheduling failed.",
      );
      return null;
    } finally {
      setIsSubmitting(false);
    }
  }

  async function approveInterpretation() {
    if (!intakeResult) {
      return;
    }

    const nextDraft: DraftState = {
      attendeeEmails: intakeResult.attendeeEmails,
      durationMinutes: intakeResult.interpretation.durationMinutes,
      notes: intakeResult.interpretation.notes,
      preferredWindow: intakeResult.interpretation.preferredWindow,
      priority: intakeResult.interpretation.priority,
      promptTiming: intakeResult.timing,
      reminderMinutes: intakeResult.reminderMinutes,
      timeZone: draft.timeZone,
      title: intakeResult.interpretation.title,
    };

    setDraft(nextDraft);
    setStep("recommend");
    await handleSchedule("preview", nextDraft);
  }

  if (!session) {
    return (
      <main className="soft-grid min-h-screen px-5 py-8 text-[var(--foreground)] md:px-10 md:py-10">
        <section className="glass-panel relative mx-auto grid min-h-[calc(100vh-4rem)] w-full max-w-6xl overflow-hidden rounded-[2rem] border p-8 md:p-12 lg:grid-cols-[0.92fr_1.08fr] lg:items-stretch">
          <div className="pointer-events-none absolute inset-0 lg:hidden">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_22%,rgba(216,140,65,0.22),transparent_28%),radial-gradient(circle_at_86%_18%,rgba(21,93,82,0.16),transparent_28%),radial-gradient(circle_at_62%_82%,rgba(17,32,51,0.08),transparent_30%)]" />
            <div className="absolute -left-10 top-20 h-52 w-52 rounded-full bg-[rgba(216,140,65,0.14)] blur-3xl" />
            <div className="absolute bottom-0 right-0 h-64 w-64 rounded-full bg-[rgba(21,93,82,0.12)] blur-3xl" />
          </div>

          <div className="relative z-10 flex flex-col justify-center space-y-8">
            <div className="space-y-6">
              <div className="inline-flex w-fit items-center gap-2 rounded-full border border-[rgba(17,32,51,0.12)] bg-[rgba(255,255,255,0.72)] px-4 py-2 text-sm font-medium text-[var(--muted)]">
                <span className="inline-flex size-2 rounded-full bg-[var(--signal)]" />
                Simple voice scheduling
              </div>
              <div className="space-y-4">
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                  Calendar Assistant
                </p>
                <h1 className="display-font max-w-4xl text-5xl leading-none font-semibold tracking-tight md:text-7xl">
                  Speak it.
                  <br />
                  Check it.
                  <br />
                  Book it.
                </h1>
                <p className="max-w-xl text-lg leading-8 text-[var(--muted)]">
                  Record a request, review what the app understood, then confirm the
                  recommended time one step at a time.
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
            </div>

            {!googleConfigured ? (
              <div className="rounded-[1.75rem] border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] p-5 text-sm leading-7 text-[var(--foreground)]">
                Add the Google auth values from <code>.env.example</code> before sign-in
                will work locally or on Vercel.
              </div>
            ) : null}
          </div>

          <div className="relative hidden min-h-[560px] self-stretch overflow-hidden rounded-[2rem] border border-[rgba(17,32,51,0.1)] bg-[linear-gradient(160deg,rgba(255,255,255,0.9),rgba(250,243,232,0.72))] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] lg:block lg:min-h-full">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(216,140,65,0.28),transparent_24%),radial-gradient(circle_at_80%_18%,rgba(21,93,82,0.24),transparent_26%),radial-gradient(circle_at_52%_70%,rgba(17,32,51,0.12),transparent_24%)]" />
            <div className="absolute -top-10 right-8 h-44 w-44 rounded-full bg-[rgba(216,140,65,0.2)] blur-2xl" />
            <div className="absolute bottom-4 left-0 h-56 w-56 rounded-full bg-[rgba(21,93,82,0.18)] blur-3xl" />

            <div className="relative flex h-full min-h-[520px] items-center justify-center">
              <div className="relative h-full min-h-[500px] w-full max-w-[520px]">
                <div className="absolute left-[10%] top-[12%] h-40 w-40 rounded-[36%_64%_55%_45%/42%_42%_58%_58%] border border-[rgba(17,32,51,0.08)] bg-[linear-gradient(145deg,rgba(21,93,82,0.94),rgba(45,121,109,0.7))] shadow-[0_28px_60px_rgba(21,93,82,0.2)]" />
                <div className="absolute right-[11%] top-[18%] h-28 w-28 rounded-full border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.86)] shadow-[0_20px_40px_rgba(17,32,51,0.1)]" />
                <div className="absolute bottom-[7%] left-[17%] h-24 w-52 rounded-full border border-[rgba(17,32,51,0.08)] bg-[linear-gradient(120deg,rgba(17,32,51,0.08),rgba(216,140,65,0.18))] backdrop-blur-sm" />
                <div className="absolute bottom-[19%] right-[14%] h-36 w-36 rounded-[62%_38%_33%_67%/43%_53%_47%_57%] border border-[rgba(17,32,51,0.08)] bg-[linear-gradient(135deg,rgba(255,255,255,0.96),rgba(247,232,212,0.9))] shadow-[0_18px_42px_rgba(17,32,51,0.12)]" />

                <div className="absolute left-[23%] top-[26%] rounded-[1.5rem] border border-[rgba(255,255,255,0.4)] bg-[rgba(255,255,255,0.18)] px-4 py-3 text-sm font-semibold tracking-[0.18em] text-white uppercase shadow-[0_16px_34px_rgba(17,32,51,0.18)] backdrop-blur-md">
                  Record
                </div>
                <div className="absolute right-[16%] top-[40%] rounded-[1.4rem] border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.88)] px-4 py-3 text-sm font-semibold tracking-[0.18em] text-[var(--foreground)] uppercase shadow-[0_16px_34px_rgba(17,32,51,0.12)]">
                  Review
                </div>
                <div className="absolute bottom-[18%] left-[34%] rounded-[1.4rem] border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.86)] px-4 py-3 text-sm font-semibold tracking-[0.18em] text-[var(--foreground)] uppercase shadow-[0_16px_34px_rgba(17,32,51,0.12)]">
                  Confirm
                </div>

                <div className="absolute left-[30%] top-[34%] h-px w-[34%] rotate-[11deg] bg-[linear-gradient(90deg,rgba(255,255,255,0.6),rgba(255,255,255,0.1))]" />
                <div className="absolute left-[46%] top-[58%] h-px w-[24%] -rotate-[22deg] bg-[linear-gradient(90deg,rgba(17,32,51,0.16),rgba(17,32,51,0.02))]" />
              </div>
            </div>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="soft-grid min-h-screen px-4 py-5 text-[var(--foreground)] md:px-8 md:py-8">
      <div className="glass-panel mx-auto flex w-full max-w-3xl flex-col gap-6 rounded-[2rem] border p-4 md:p-6">
        <header className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface-strong)] p-5 md:p-7">
          <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
            <div className="space-y-4">
              <div className="inline-flex w-fit items-center gap-2 rounded-full bg-[var(--surface-accent)] px-4 py-2 text-sm font-semibold text-[var(--button)]">
                <span className="inline-flex size-2 rounded-full bg-[var(--signal)]" />
                Google Calendar is connected
              </div>
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">
                  Guided flow
                </p>
                <h1 className="display-font mt-3 text-3xl leading-none font-semibold md:text-5xl">
                  One step at a time.
                </h1>
                <p className="mt-4 max-w-2xl text-base leading-7 text-[var(--muted)]">
                  Record your request, confirm what the app understood, then approve the
                  time recommendation.
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
              booking starts failing.
            </div>
          ) : null}
        </header>

        <section className="rounded-[1.75rem] border border-[var(--border)] bg-[var(--surface)] p-5 md:p-7">
          <div className="flex flex-wrap gap-2">
            <StepMarker active={step === "record"} label="Record" stepNumber={1} />
            <StepMarker active={step === "review"} label="Review" stepNumber={2} />
            <StepMarker active={step === "recommend"} label="Confirm" stepNumber={3} />
          </div>

          {step === "record" ? (
            <div className="mt-6 space-y-5">
              <div className="space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                  Step 1 of 3
                </p>
                <h2 className="text-3xl font-semibold">Record or type your request</h2>
                <p className="text-base leading-7 text-[var(--muted)]">
                  Say what you want in plain English. If you include a specific time or day,
                  the app will try to honor that before falling back to priority rules.
                </p>
              </div>

              <VoiceIntake
                disabled={isIntakeBusy}
                isBusy={isIntakeBusy}
                onAudioReady={handleAudioReady}
              />

              <div className="rounded-3xl border border-[rgba(17,32,51,0.08)] bg-[rgba(255,255,255,0.76)] px-4 py-3 text-sm leading-6 text-[var(--muted)]">
                {intakeStatus ??
                  "You can also type your request if you do not want to record it."}
              </div>

              <div className="field-shell rounded-[1.5rem] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    Request text
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="text-sm font-semibold text-[var(--button)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isIntakeBusy}
                      onClick={handleAnalyzeText}
                      type="button"
                    >
                      {isIntakeBusy ? "Working..." : "Continue"}
                    </button>
                    <button
                      className="text-sm font-semibold text-[var(--muted)]"
                      onClick={resetFlow}
                      type="button"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <textarea
                  className="mt-3 min-h-32 w-full resize-none bg-transparent text-base leading-7 outline-none"
                  onChange={(event) => setManualPrompt(event.target.value)}
                  placeholder='Example: Schedule a 30 minute meeting at 12:30 PM today and call it "Test Meeting".'
                  value={manualPrompt}
                />
              </div>

              {intakeError ? (
                <div className="rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  {intakeError}
                </div>
              ) : null}
            </div>
          ) : null}

          {step === "review" && intakeResult ? (
            <div className="mt-6 space-y-5">
              <div className="space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                  Step 2 of 3
                </p>
                <h2 className="text-3xl font-semibold">Review what I understood</h2>
                <p className="text-base leading-7 text-[var(--muted)]">
                  If anything looks wrong, edit the text and re-run it or go back and
                  record again.
                </p>
              </div>

              <div className="rounded-[1.5rem] bg-[rgba(21,93,82,0.08)] p-5">
                <p className="text-base leading-7 text-[var(--foreground)]">
                  {intakeResult.interpretation.userConfirmationMessage}
                </p>
              </div>

              <div className="rounded-[1.5rem] border border-[var(--border)] bg-[rgba(255,255,255,0.82)] p-5">
                <div className="grid gap-3 text-sm leading-6 text-[var(--foreground)] md:grid-cols-2">
                  <p>
                    <span className="font-semibold">Title:</span>{" "}
                    {intakeResult.interpretation.title}
                  </p>
                  <p>
                    <span className="font-semibold">Duration:</span>{" "}
                    {formatDurationSummary(intakeResult.interpretation.durationMinutes)}
                  </p>
                  <p>
                    <span className="font-semibold">When:</span>{" "}
                    {formatTimingSummary(intakeResult.timing)}
                  </p>
                  <p>
                    <span className="font-semibold">Engine:</span>{" "}
                    {formatIntakeEngine(intakeResult.engine)}
                  </p>
                  {intakeResult.timing.mode === "flexible" ? (
                    <>
                      <p>
                        <span className="font-semibold">Priority:</span>{" "}
                        {intakeResult.interpretation.priority}
                      </p>
                      <p>
                        <span className="font-semibold">Window:</span>{" "}
                        {intakeResult.interpretation.preferredWindow}
                      </p>
                    </>
                  ) : null}
                  <p>
                    <span className="font-semibold">Google Meet:</span> Added automatically
                  </p>
                  <p>
                    <span className="font-semibold">Attendees:</span>{" "}
                    {intakeResult.attendeeEmails.length > 0
                      ? intakeResult.attendeeEmails.join(", ")
                      : "None detected"}
                  </p>
                  <p className="md:col-span-2">
                    <span className="font-semibold">Reminders:</span>{" "}
                    {formatReminderSummary(intakeResult.reminderMinutes)}
                  </p>
                </div>
              </div>

              <div className="field-shell rounded-[1.5rem] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                    Editable prompt
                  </span>
                  <button
                    className="text-sm font-semibold text-[var(--button)] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isIntakeBusy}
                    onClick={handleAnalyzeText}
                    type="button"
                  >
                    {isIntakeBusy ? "Re-checking..." : "Re-analyze"}
                  </button>
                </div>
                <textarea
                  className="mt-3 min-h-32 w-full resize-none bg-transparent text-base leading-7 outline-none"
                  onChange={(event) => setManualPrompt(event.target.value)}
                  value={manualPrompt}
                />
              </div>

              {intakeResult.interpretation.needsClarification ? (
                <div className="rounded-3xl border border-[rgba(216,140,65,0.2)] bg-[rgba(216,140,65,0.12)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  This request still looks uncertain. Re-record if the summary is off.
                </div>
              ) : null}

              {intakeError ? (
                <div className="rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  {intakeError}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                <button
                  className="rounded-full bg-[var(--button)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--button-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isSubmitting}
                  onClick={approveInterpretation}
                  type="button"
                >
                  Approve and continue
                </button>
                <button
                  className="rounded-full border border-[rgba(17,32,51,0.12)] px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                  onClick={() => setStep("record")}
                  type="button"
                >
                  Back
                </button>
                <button
                  className="rounded-full border border-[rgba(17,32,51,0.12)] px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                  onClick={resetFlow}
                  type="button"
                >
                  Re-record
                </button>
              </div>
            </div>
          ) : null}

          {step === "recommend" ? (
            <div className="mt-6 space-y-5">
              <div className="space-y-3">
                <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                  Step 3 of 3
                </p>
                <h2 className="text-3xl font-semibold">Confirm the recommendation</h2>
                <p className="text-base leading-7 text-[var(--muted)]">
                  Review the proposed slot, then book it into Google Calendar if it looks
                  right.
                </p>
              </div>

              {isSubmitting && !result ? (
                <div className="rounded-[1.5rem] border border-[var(--border)] bg-[rgba(255,255,255,0.82)] p-5 text-base leading-7 text-[var(--foreground)]">
                  Finding the best slot for you...
                </div>
              ) : null}

              {result ? (
                <div className="space-y-4">
                  <div className="rounded-[1.5rem] border border-[var(--border)] bg-[rgba(255,255,255,0.86)] p-5">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
                      {result.matchType === "requested"
                        ? "Requested slot"
                        : result.matchType === "adjusted"
                          ? "Adjusted recommendation"
                          : draft.promptTiming.mode === "flexible"
                        ? "Recommended slot"
                        : "Requested slot"}
                    </p>
                    <h3 className="mt-2 text-3xl font-semibold">{result.title}</h3>
                    <p className="mt-3 text-base leading-7 text-[var(--foreground)]">
                      {formatSlotTime(result.slot.start, result.slot.timeZone)} to{" "}
                      {formatSlotTime(result.slot.end, result.slot.timeZone)}
                    </p>
                    <span className="mt-4 inline-flex rounded-full bg-[var(--surface-accent)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--button)]">
                      {result.slot.bucket}
                    </span>
                    <div className="mt-5 grid gap-2 text-sm leading-6 text-[var(--foreground)] md:grid-cols-2">
                      <p>
                        <span className="font-semibold">Duration:</span>{" "}
                        {formatDurationSummary(draft.durationMinutes)}
                      </p>
                      <p>
                        <span className="font-semibold">Google Meet:</span> Included
                      </p>
                      <p>
                        <span className="font-semibold">Attendees:</span>{" "}
                        {draft.attendeeEmails.length > 0
                          ? draft.attendeeEmails.join(", ")
                          : "None added"}
                      </p>
                      <p>
                        <span className="font-semibold">Reminders:</span>{" "}
                        {formatReminderSummary(draft.reminderMinutes)}
                      </p>
                    </div>
                  </div>

                  <p className="rounded-[1.5rem] bg-[rgba(17,32,51,0.04)] p-5 text-sm leading-7 text-[var(--foreground)]">
                    {result.rationale}
                  </p>

                  {draft.promptTiming.mode === "flexible" ? (
                    <div className="rounded-[1.5rem] bg-[rgba(216,140,65,0.12)] p-4 text-sm leading-6 text-[var(--foreground)]">
                      Priority only came into play because your request did not include a
                      specific day and time.
                    </div>
                  ) : result.matchType === "adjusted" ? (
                    <div className="rounded-[1.5rem] bg-[rgba(216,140,65,0.12)] p-4 text-sm leading-6 text-[var(--foreground)]">
                      A specific time was detected, but that slot was not available, so I
                      suggested the closest opening later that same day.
                    </div>
                  ) : (
                    <div className="rounded-[1.5rem] bg-[rgba(21,93,82,0.08)] p-4 text-sm leading-6 text-[var(--foreground)]">
                      A specific time or day was detected, so priority was not used to pick
                      this slot.
                    </div>
                  )}
                </div>
              ) : null}

              {requestError ? (
                <div className="rounded-3xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-4 py-3 text-sm leading-6 text-[var(--foreground)]">
                  {requestError}
                </div>
              ) : null}

              <div className="flex flex-wrap gap-3">
                {result?.status === "previewed" ? (
                  <button
                    className="rounded-full bg-[var(--button)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--button-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                    disabled={isSubmitting}
                    onClick={() => handleSchedule("book")}
                    type="button"
                  >
                    {isSubmitting ? "Booking..." : "Book this slot"}
                  </button>
                ) : null}
                {result?.status === "booked" && result.eventLink ? (
                  <a
                    className="rounded-full bg-[var(--button)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[var(--button-hover)]"
                    href={result.eventLink}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open in Google Calendar
                  </a>
                ) : null}
                <button
                  className="rounded-full border border-[rgba(17,32,51,0.12)] px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                  onClick={() => setStep("review")}
                  type="button"
                >
                  Back
                </button>
                <button
                  className="rounded-full border border-[rgba(17,32,51,0.12)] px-5 py-3 text-sm font-semibold transition hover:bg-[rgba(17,32,51,0.04)]"
                  onClick={resetFlow}
                  type="button"
                >
                  Start over
                </button>
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
