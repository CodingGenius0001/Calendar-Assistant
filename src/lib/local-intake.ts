"use client";

import {
  calendarIntentJsonSchema,
  calendarIntentSchema,
  type CalendarIntent,
} from "@/lib/intent";

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
  engine: IntakeEngine;
  interpretation: CalendarIntent;
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
  "durationMinutes defaults to 45.",
  "preferredWindow defaults to any.",
  "requestedDateLabel should briefly describe the user's implied timing, like today, tomorrow, later this week, or the closest exact phrase from the user.",
  "If the request is too ambiguous to trust, set needsClarification to true and confidence to low.",
  "Keep userConfirmationMessage short and written for the end user.",
  "Return only valid JSON matching the provided schema.",
].join(" ");

function formatProgress(prefix: string, progress: ProgressEvent) {
  const progressPercent =
    typeof progress.progress === "number"
      ? ` ${Math.round(progress.progress * 100)}%`
      : "";
  const detail = progress.text ?? progress.status ?? progress.file ?? "loading";
  return `${prefix}: ${detail}${progressPercent}`;
}

function normalizeTranscript(transcript: string) {
  return transcript.replace(/\s+/g, " ").trim();
}

function inferPriority(transcript: string): CalendarIntent["priority"] {
  if (/\b(urgent|asap|immediately|today|right away|high priority)\b/i.test(transcript)) {
    return "high";
  }

  if (/\b(low priority|later this week|sometime|not urgent|whenever)\b/i.test(transcript)) {
    return "low";
  }

  return "medium";
}

function inferWindow(transcript: string): CalendarIntent["preferredWindow"] {
  if (/\b(morning|am|before noon|early)\b/i.test(transcript)) {
    return "morning";
  }

  if (/\b(afternoon|after lunch)\b/i.test(transcript)) {
    return "afternoon";
  }

  if (/\b(evening|tonight|night)\b/i.test(transcript)) {
    return "evening";
  }

  return "any";
}

function inferRequestedDateLabel(transcript: string, priority: CalendarIntent["priority"]) {
  const explicitDateMatch = transcript.match(
    /\b(today|tomorrow|this week|later this week|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
  );

  if (explicitDateMatch) {
    return explicitDateMatch[0].toLowerCase();
  }

  if (priority === "high") {
    return "today";
  }

  if (priority === "low") {
    return "later this week";
  }

  return "tomorrow";
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

  return 45;
}

function inferTitle(transcript: string) {
  const cleaned = normalizeTranscript(transcript);

  if (!cleaned) {
    return "New agenda item";
  }

  const firstClause = cleaned
    .split(/[,.!?]| and /i)
    .map((segment) => segment.trim())
    .find(Boolean);

  const candidate = (firstClause ?? cleaned).split(" ").slice(0, 7).join(" ");
  return candidate.length > 120 ? candidate.slice(0, 117).trimEnd() : candidate;
}

function buildConfirmationMessage(intent: CalendarIntent) {
  return `I understood this as "${intent.title}" for ${intent.durationMinutes} minutes, with ${intent.priority} priority${intent.preferredWindow === "any" ? "" : ` in the ${intent.preferredWindow}`}.`;
}

function buildFallbackIntent(transcript: string): CalendarIntent {
  const notes = normalizeTranscript(transcript);
  const priority = inferPriority(notes);
  const preferredWindow = inferWindow(notes);
  const durationMinutes = inferDurationMinutes(notes);
  const requestedDateLabel = inferRequestedDateLabel(notes, priority);
  const title = inferTitle(notes);
  const needsClarification = notes.split(" ").length < 4;
  const confidence = needsClarification ? "low" : "medium";

  return {
    action: "schedule_event",
    confidence,
    durationMinutes,
    needsClarification,
    notes,
    preferredWindow,
    priority,
    requestedDateLabel,
    title,
    userConfirmationMessage: buildConfirmationMessage({
      action: "schedule_event",
      confidence,
      durationMinutes,
      needsClarification,
      notes,
      preferredWindow,
      priority,
      requestedDateLabel,
      title,
      userConfirmationMessage: "",
    }),
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
          onStatus?.(formatProgress("Speech model", progress));
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
          onStatus?.(formatProgress("Intent model", report));
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
    onStatus?.("Transcribing the recording...");
    const output = await transcriber(blobUrl, {
      chunk_length_s: 20,
      language: "english",
      stride_length_s: 5,
      task: "transcribe",
    });

    if (
      typeof output === "object" &&
      output !== null &&
      "text" in output &&
      typeof output.text === "string"
    ) {
      return normalizeTranscript(output.text);
    }

    throw new Error("The speech model returned an invalid transcript.");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

export async function interpretTranscriptLocally(
  transcript: string,
  onStatus?: StatusCallback,
): Promise<LocalIntakeResult> {
  const normalizedTranscript = normalizeTranscript(transcript);

  if (!normalizedTranscript) {
    throw new Error("The transcript was empty.");
  }

  try {
    const engine = await getIntentEngine(onStatus);

    onStatus?.("Inferring the calendar intent...");

    const response = await engine.chat.completions.create({
      frequency_penalty: 0,
      messages: [
        { content: INTENT_SYSTEM_PROMPT, role: "system" },
        { content: normalizedTranscript, role: "user" },
      ],
      presence_penalty: 0,
      response_format: {
        schema: JSON.stringify(calendarIntentJsonSchema),
        type: "json_object",
      },
      temperature: 0.1,
    });

    const content = getMessageContent(response);
    const parsedIntent = calendarIntentSchema.parse(
      JSON.parse(extractJsonObject(content)),
    );

    return {
      engine: "local-llm",
      interpretation: parsedIntent,
      transcript: normalizedTranscript,
    };
  } catch {
    onStatus?.("Using the built-in fallback parser...");

    return {
      engine: "rules-fallback",
      interpretation: buildFallbackIntent(normalizedTranscript),
      transcript: normalizedTranscript,
    };
  }
}

export { INTENT_MODEL_ID, SPEECH_MODEL_ID, isWebGpuAvailable };
export type { IntakeEngine, LocalIntakeResult };
