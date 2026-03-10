"use client";

import {
  calendarIntentJsonSchema,
  calendarIntentSchema,
  type CalendarIntent,
} from "@/lib/intent";
import {
  extractPromptDetails,
  normalizePromptText,
  toDisplayTitle,
  type PromptTiming,
} from "@/lib/prompt-details";

const SPEECH_MODEL_ID = "Xenova/whisper-base.en";
const INTENT_MODEL_ID = "Qwen2.5-0.5B-Instruct-q4f16_1-MLC";

type IntakeEngine = "local-llm" | "rules-fallback";
type StatusCallback = (status: string) => void;

type ProgressEvent = {
  file?: string;
  progress?: number;
  status?: string;
  text?: string;
};

type LocalIntakeResult = {
  attendeeEmails: string[];
  engine: IntakeEngine;
  interpretation: CalendarIntent;
  reminderMinutes: number[];
  timing: PromptTiming;
  transcript: string;
};

type LocalIntentEngine = {
  chat: {
    completions: {
      create: (options: {
        frequency_penalty: number;
        messages: Array<{ content: string; role: "system" | "user" }>;
        presence_penalty: number;
        response_format: {
          schema: string;
          type: "json_object";
        };
        temperature: number;
      }) => Promise<unknown>;
    };
  };
};

let transcriberPromise: Promise<
  (input: string, options?: Record<string, unknown>) => Promise<unknown>
> | null = null;
let intentEnginePromise: Promise<unknown> | null = null;

const INTENT_SYSTEM_PROMPT = [
  "You convert a user's calendar request into a structured scheduling intent.",
  "Infer the most likely scheduling task from the transcript.",
  "Use conservative defaults when details are missing.",
  "priority defaults to medium.",
  "durationMinutes defaults to 30.",
  "preferredWindow defaults to any.",
  "requestedDateLabel should briefly describe the user's implied timing, like today, tomorrow, later this week, or the closest exact phrase from the user.",
  "If the request is too ambiguous to trust, set needsClarification to true and confidence to low.",
  "Keep userConfirmationMessage short and written for the end user.",
  "Return only valid JSON matching the provided schema.",
].join(" ");

const GENERIC_EVENT_TITLES = new Set([
  "agenda item",
  "appointment",
  "call",
  "chat",
  "event",
  "meeting",
  "new agenda item",
  "scheduled appointment",
  "scheduled call",
  "scheduled event",
  "scheduled meeting",
  "session",
  "sync",
]);

function formatProgressPercent(progressValue?: number) {
  if (typeof progressValue !== "number" || !Number.isFinite(progressValue)) {
    return "";
  }

  if (progressValue >= 0 && progressValue <= 1) {
    return ` ${Math.round(progressValue * 100)}%`;
  }

  if (progressValue > 1 && progressValue <= 100) {
    return ` ${Math.round(progressValue)}%`;
  }

  return "";
}

function formatModelLoadingStatus(label: string, progress: ProgressEvent) {
  const percent = formatProgressPercent(progress.progress);
  return percent
    ? `Downloading ${label}...${percent}`
    : `Preparing ${label}...`;
}

function inferDurationMinutes(transcript: string) {
  const hourMinuteMatch = transcript.match(
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

  const hourOnlyMatch = transcript.match(/\b(\d+)\s*(?:hour|hours|hr|hrs)\b/i);

  if (hourOnlyMatch) {
    const totalMinutes = Number(hourOnlyMatch[1]) * 60;

    if (totalMinutes >= 15 && totalMinutes <= 240) {
      return totalMinutes;
    }
  }

  const minuteOnlyMatch = transcript.match(/\b(\d+)\s*(?:minute|minutes|min|mins)\b/i);

  if (minuteOnlyMatch) {
    const totalMinutes = Number(minuteOnlyMatch[1]);

    if (totalMinutes >= 15 && totalMinutes <= 240) {
      return totalMinutes;
    }
  }

  return 30;
}

function inferTitle(transcript: string) {
  const cleaned = normalizePromptText(transcript);

  if (!cleaned) {
    return "New agenda item";
  }

  const firstClause = cleaned
    .split(/[,.!?]| and /i)
    .map((segment) => segment.trim())
    .find(Boolean);

  const candidate = (firstClause ?? cleaned).split(" ").slice(0, 7).join(" ");
  const trimmedCandidate =
    candidate.length > 120 ? candidate.slice(0, 117).trimEnd() : candidate;
  return toDisplayTitle(trimmedCandidate);
}

function isWeakTitleCandidate(value: string) {
  const normalized = normalizePromptText(value).toLowerCase();

  if (!normalized) {
    return true;
  }

  if (GENERIC_EVENT_TITLES.has(normalized)) {
    return true;
  }

  return /^(schedule|book|create|add|make)\b/i.test(normalized);
}

function formatDurationLabel(durationMinutes: number) {
  if (durationMinutes % 60 === 0) {
    const hours = durationMinutes / 60;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }

  return `${durationMinutes} minutes`;
}

function buildConfirmationMessage(intent: CalendarIntent, timing: PromptTiming) {
  if (timing.mode === "exact") {
    return `I understood this as "${intent.title}" for ${formatDurationLabel(intent.durationMinutes)}, scheduled for ${timing.requestedDateLabel}.`;
  }

  if (timing.mode === "day") {
    return `I understood this as "${intent.title}" for ${formatDurationLabel(intent.durationMinutes)} on ${timing.requestedDateLabel}.`;
  }

  return `I understood this as "${intent.title}" for ${formatDurationLabel(intent.durationMinutes)}, with ${intent.priority} priority${intent.preferredWindow === "any" ? "" : ` in the ${intent.preferredWindow}`}.`;
}

function finalizeIntent(
  intent: CalendarIntent,
  details: ReturnType<typeof extractPromptDetails>,
): CalendarIntent {
  const preferredTitle = details.suggestedTitle || inferTitle(intent.notes);
  const titleSource = isWeakTitleCandidate(intent.title)
    ? preferredTitle
    : intent.title.trim() || preferredTitle;
  const title = toDisplayTitle(titleSource);
  const durationMinutes = details.explicitDurationMinutes ?? intent.durationMinutes;

  return {
    ...intent,
    durationMinutes,
    preferredWindow: details.preferredWindow,
    priority: details.priority,
    requestedDateLabel: details.timing.requestedDateLabel,
    title,
    userConfirmationMessage: buildConfirmationMessage(
      {
        ...intent,
        durationMinutes,
        preferredWindow: details.preferredWindow,
        priority: details.priority,
        requestedDateLabel: details.timing.requestedDateLabel,
        title,
      },
      details.timing,
    ),
  };
}

function buildFallbackIntent(
  transcript: string,
  details: ReturnType<typeof extractPromptDetails>,
): CalendarIntent {
  const notes = normalizePromptText(transcript);
  const durationMinutes =
    details.explicitDurationMinutes ?? inferDurationMinutes(notes);
  const title = toDisplayTitle(details.suggestedTitle || inferTitle(notes));
  const needsClarification = notes.split(" ").length < 4;
  const confidence = needsClarification ? "low" : "medium";

  return {
    action: "schedule_event",
    confidence,
    durationMinutes,
    needsClarification,
    notes,
    preferredWindow: details.preferredWindow,
    priority: details.priority,
    requestedDateLabel: details.timing.requestedDateLabel,
    title,
    userConfirmationMessage: buildConfirmationMessage({
      action: "schedule_event",
      confidence,
      durationMinutes,
      needsClarification,
      notes,
      preferredWindow: details.preferredWindow,
      priority: details.priority,
      requestedDateLabel: details.timing.requestedDateLabel,
      title,
      userConfirmationMessage: "",
    }, details.timing),
  };
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new Error("The local model returned an empty response.");
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");

  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    throw new Error("The local model did not return valid JSON.");
  }

  return trimmed.slice(objectStart, objectEnd + 1);
}

function getMessageContent(result: unknown) {
  if (
    typeof result === "object" &&
    result !== null &&
    "choices" in result &&
    Array.isArray(result.choices) &&
    result.choices[0] &&
    typeof result.choices[0] === "object" &&
    result.choices[0] !== null &&
    "message" in result.choices[0] &&
    typeof result.choices[0].message === "object" &&
    result.choices[0].message !== null &&
    "content" in result.choices[0].message
  ) {
    const { content } = result.choices[0].message as { content?: unknown };

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((item) =>
          typeof item === "object" && item !== null && "text" in item
            ? String(item.text ?? "")
            : "",
        )
        .join("");
    }
  }

  throw new Error("The local model response was malformed.");
}

function isWebGpuAvailable() {
  return typeof navigator !== "undefined" && "gpu" in navigator;
}

async function getTranscriber(onStatus?: StatusCallback) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      onStatus?.("Loading the local speech-to-text model...");

      return pipeline("automatic-speech-recognition", SPEECH_MODEL_ID, {
        device: isWebGpuAvailable() ? "webgpu" : "wasm",
        progress_callback: (progress: ProgressEvent) => {
          onStatus?.(formatModelLoadingStatus("speech model", progress));
        },
      });
    })().catch((error) => {
      transcriberPromise = null;
      throw error;
    });
  }

  return transcriberPromise;
}

async function getIntentEngine(onStatus?: StatusCallback) {
  if (!intentEnginePromise) {
    intentEnginePromise = (async () => {
      if (!isWebGpuAvailable()) {
        throw new Error("WebGPU is unavailable.");
      }

      const { CreateMLCEngine } = await import("@mlc-ai/web-llm");

      onStatus?.("Loading the local intent model...");

      return CreateMLCEngine(INTENT_MODEL_ID, {
        initProgressCallback: (report: ProgressEvent) => {
          onStatus?.(formatModelLoadingStatus("understanding model", report));
        },
      });
    })().catch((error) => {
      intentEnginePromise = null;
      throw error;
    });
  }

  return (await intentEnginePromise) as LocalIntentEngine;
}

export async function transcribeAudioLocally(
  audioFile: File,
  onStatus?: StatusCallback,
) {
  const transcriber = await getTranscriber(onStatus);
  const blobUrl = URL.createObjectURL(audioFile);

  try {
    onStatus?.("Transcribing your recording...");
    const output = await transcriber(blobUrl, {
      chunk_length_s: 20,
      stride_length_s: 5,
    });

    if (
      typeof output === "object" &&
      output !== null &&
      "text" in output &&
      typeof output.text === "string"
    ) {
      return normalizePromptText(output.text);
    }

    throw new Error("The speech model returned an invalid transcript.");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function interpretTranscriptLocally(
  transcript: string,
  context: {
    now: Date;
    timeZone: string;
  },
  onStatus?: StatusCallback,
): Promise<LocalIntakeResult> {
  const normalizedTranscript = normalizePromptText(transcript);

  if (!normalizedTranscript) {
    throw new Error("The transcript was empty.");
  }

  const promptDetails = extractPromptDetails(normalizedTranscript, context);

  try {
    const engine = await getIntentEngine(onStatus);

    onStatus?.("Understanding your request...");

    const response = await engine.chat.completions.create({
      frequency_penalty: 0,
      messages: [
        { content: INTENT_SYSTEM_PROMPT, role: "system" },
        {
          content: [
            `User time zone: ${context.timeZone}.`,
            `User local time: ${context.now.toISOString()}.`,
            `Transcript: ${normalizedTranscript}`,
          ].join(" "),
          role: "user",
        },
      ],
      presence_penalty: 0,
      response_format: {
        schema: JSON.stringify(calendarIntentJsonSchema),
        type: "json_object",
      },
      temperature: 0.1,
    });

    const content = getMessageContent(response);
    const parsedIntent = finalizeIntent(
      calendarIntentSchema.parse(JSON.parse(extractJsonObject(content))),
      promptDetails,
    );

    return {
      attendeeEmails: promptDetails.attendeeEmails,
      engine: "local-llm",
      interpretation: parsedIntent,
      reminderMinutes: promptDetails.reminderMinutes,
      timing: promptDetails.timing,
      transcript: normalizedTranscript,
    };
  } catch {
    onStatus?.("Switching to the built-in fallback parser...");

    return {
      attendeeEmails: promptDetails.attendeeEmails,
      engine: "rules-fallback",
      interpretation: buildFallbackIntent(normalizedTranscript, promptDetails),
      reminderMinutes: promptDetails.reminderMinutes,
      timing: promptDetails.timing,
      transcript: normalizedTranscript,
    };
  }
}

export { INTENT_MODEL_ID, SPEECH_MODEL_ID, isWebGpuAvailable };
export type { IntakeEngine, LocalIntakeResult };
