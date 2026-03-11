# Calendar Assistant

Calendar Assistant is a speech-first scheduling app for Google Calendar. You sign in with Google, record or type a meeting request, review what the app understood, preview the best open time, and then book the event into your calendar with a Google Meet link and optional reminders.

## What the app does

- Authenticates users with Google OAuth through NextAuth.js
- Records voice prompts in the browser with `MediaRecorder`
- Transcribes audio locally in the browser with Whisper
- Interprets the request locally with a browser LLM, with a rules-based fallback if the local model cannot run
- Extracts the meeting title, timing, duration, attendees, reminders, priority, and preferred time window
- Checks the signed-in user's Google Calendar availability on the server
- Recommends the best slot, including exact-time matches, same-day adjustments, or priority-based suggestions
- Offers alternative open times before booking
- Creates the event directly in the user's primary Google Calendar with Google Meet conferencing

The current implementation does not use a database. Auth state is handled by NextAuth.js and events are read from and written directly to each user's Google Calendar.

## Technologies used

### App stack

- Next.js 16 App Router
- React 19
- TypeScript 5
- Tailwind CSS 4

### Auth, validation, and scheduling

- `next-auth` for Google sign-in and token refresh
- `googleapis` for Calendar free/busy checks and event creation
- `zod` for request validation
- `date-fns` and `date-fns-tz` for time calculations and timezone handling

### Local AI stack

- `@huggingface/transformers` with `Xenova/whisper-base.en` for in-browser speech-to-text
- `@mlc-ai/web-llm` with `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` for local intent parsing
- Built-in rules fallback parser when WebGPU or the local LLM is unavailable

## How the scheduling flow works

1. The user signs in with Google.
2. The app records audio or accepts typed prompt text.
3. The browser transcribes and interprets the request locally.
4. The user reviews the parsed result and can re-analyze edited prompt text.
5. The server checks Google Calendar availability for the relevant search window.
6. The app previews a recommended slot and shows alternatives when available.
7. On confirmation, the app creates the event in Google Calendar and returns Calendar and Meet links.

## Scheduling behavior

- Exact day/time requests are honored when possible.
- If an exact requested time is unavailable, the app searches for the next opening later that same day.
- Day-only requests search that day first.
- Flexible requests use priority rules:
  - `high`: today first
  - `medium`: tomorrow first
  - `low`: later this week first
- Preferred windows (`morning`, `afternoon`, `evening`, `any`) influence which open slot is selected.

## Local development

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env.local` and provide:

```bash
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=replace-with-a-long-random-string
GOOGLE_CLIENT_ID=replace-with-your-google-client-id
GOOGLE_CLIENT_SECRET=replace-with-your-google-client-secret
```

3. In Google Cloud Console:

- Create a Google OAuth web application
- Enable the Google Calendar API
- Add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI
- Add your production callback URI if you plan to deploy

4. Start the app:

```bash
npm run dev
```

## Scripts

- `npm run dev` starts the local development server
- `npm run lint` runs ESLint
- `npm run build` builds the production app
- `npm run start` serves the production build

## Deployment

The app is structured for Vercel deployment with Google OAuth. Keep secrets out of git, add the same environment variables in Vercel, and configure the matching Google OAuth redirect URI for production.

For the full setup walkthrough, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## Browser notes

- Chrome and Edge provide the best experience for microphone access and local model execution.
- The first voice interaction is slower because the browser downloads the local model files.
- If WebGPU is unavailable, voice transcription still works and intent parsing falls back to the built-in rules parser.
