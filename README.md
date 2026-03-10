# Calendar Assistant

Speech-first Google Calendar organizer built with Next.js and designed for Vercel deployment.

## What it does

- Records the user's voice prompt in the browser
- Transcribes audio with a free open-source speech-to-text model in the browser
- Feeds the transcript into a local open-source LLM to convert it into a structured calendar intent
- Shows the user a confirmation message before scheduling continues
- Lets the user edit the interpreted text or re-record the full prompt
- Suggests or books a Google Calendar slot based on priority

Priority rules in this version:

- `high`: searches today first
- `medium`: starts tomorrow
- `low`: pushes into later days

The current version does not require a database. User separation is handled through Google OAuth, and scheduling writes directly into each signed-in user's Google Calendar.

## Open-source model stack

- Speech to text: `Xenova/whisper-base.en` through `@huggingface/transformers`
- Intent inference: `Qwen2.5-0.5B-Instruct-q4f16_1-MLC` through `@mlc-ai/web-llm`
- Fallback: a built-in rules parser runs if the local LLM cannot start, so the intake flow still works on unsupported devices

This means:

- No paid AI API key is required
- Vercel only handles auth, scheduling, and Google Calendar access
- The browser downloads the local models on first use, so the first run is heavier than later runs
- Chrome or Edge on desktop gives the best chance of running the local LLM with WebGPU

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env.local` and fill in:

- `NEXTAUTH_URL`
- `NEXTAUTH_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

3. In Google Cloud Console:

- Create an OAuth client for a web app
- Enable the Google Calendar API
- Add `http://localhost:3000/api/auth/callback/google` as an authorized redirect URI
- Add your production Vercel callback URL too, for example `https://your-app.vercel.app/api/auth/callback/google`

4. Run the app:

```bash
npm run dev
```

## Vercel deployment

1. Import the project into Vercel.
2. Add the same environment variables in Vercel project settings.
3. Keep `NEXTAUTH_URL=http://localhost:3000` locally. On Vercel, you can usually leave `NEXTAUTH_URL` unset and let NextAuth detect the deployment URL from Vercel.
4. Add the matching production Google OAuth redirect URI.
5. Deploy.

For the exact Vercel + Google Cloud walkthrough, see [DEPLOYMENT.md](./DEPLOYMENT.md).

## GitHub and repo safety

- `.env.local`, `.env`, `.next`, `.vercel`, and `node_modules` are already ignored by `.gitignore`
- Do not commit Google secrets into the repo; set them in Vercel project settings instead
- A fresh clone should work with `npm install`, a valid `.env.local`, and `npm run build`
- The local AI models are downloaded by the browser at runtime, so they are not committed into the repo

## Notes

- Browser audio recording uses `MediaRecorder`, so Chrome and Edge provide the cleanest experience.
- The first voice interaction may take time because the browser is downloading model files.
- If you later want shared workspaces, audit logs, or app-side history, that is when a hosted database becomes useful.
