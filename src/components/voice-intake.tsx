"use client";

import { useEffect, useRef, useState } from "react";

type VoiceIntakeProps = {
  disabled: boolean;
  isBusy: boolean;
  onAudioReady: (file: File) => Promise<void> | void;
};

export function VoiceIntake({
  disabled,
  isBusy,
  onAudioReady,
}: VoiceIntakeProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [microphoneError, setMicrophoneError] = useState<string | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  function cleanup() {
    mediaRecorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    chunksRef.current = [];
  }

  async function startRecording() {
    try {
      setMicrophoneError(null);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
      const recorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      streamRef.current = stream;
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const type = recorder.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        cleanup();

        if (!blob.size) {
          return;
        }

        const extension = type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `calendar-prompt.${extension}`, { type });
        await onAudioReady(file);
      };

      recorder.start();
      setIsRecording(true);
    } catch {
      cleanup();
      setMicrophoneError("Microphone access was blocked or unavailable.");
      setIsRecording(false);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  return (
    <div className="rounded-3xl border border-[var(--border)] bg-[rgba(255,255,255,0.68)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[var(--muted)]">
            Voice Prompt
          </p>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
            Record your request, then I&apos;ll transcribe it and confirm what I understood.
          </p>
        </div>
        <button
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
            isRecording
              ? "bg-[var(--danger)] text-white"
              : "bg-[var(--button)] text-white hover:bg-[var(--button-hover)]"
          } disabled:cursor-not-allowed disabled:opacity-60`}
          disabled={disabled || isBusy}
          onClick={isRecording ? stopRecording : startRecording}
          type="button"
        >
          {isRecording ? "Stop recording" : isBusy ? "Processing..." : "Start recording"}
        </button>
      </div>
      <p className="mt-3 text-sm text-[var(--muted)]">
        Best in Chrome or Edge. Recording stops when you press the button again.
      </p>
      {microphoneError ? (
        <div className="mt-3 rounded-2xl border border-[rgba(174,69,52,0.18)] bg-[rgba(174,69,52,0.08)] px-3 py-2 text-sm leading-6 text-[var(--foreground)]">
          {microphoneError}
        </div>
      ) : null}
    </div>
  );
}
