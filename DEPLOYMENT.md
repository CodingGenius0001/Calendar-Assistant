# Deployment Guide

This app is set up for Vercel + Google OAuth + Google Calendar.

## Where each environment variable comes from

- `GOOGLE_CLIENT_ID`
  Get this from Google Cloud Console after you create an OAuth client ID for a Web application.
- `GOOGLE_CLIENT_SECRET`
  Same place as above. Google only shows the secret clearly when you create the client, so store it immediately.
- `NEXTAUTH_SECRET`
  Generate this yourself. One simple command:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

- `NEXTAUTH_URL`
  For local development, use `http://localhost:3000`.
  On Vercel, you can usually leave this unset because NextAuth can detect the deployment URL from Vercel system environment variables. If you set it manually, use your production domain only.

## Exact Google Cloud setup

Use one Google Cloud project for your current testing app. If you later publish publicly, consider a separate production project.

### 1. Create the project

1. Open Google Cloud Console.
2. Create a new project for this app.
3. Name it something like `Calendar Assistant`.

### 2. Enable the Google Calendar API

1. Go to `APIs & Services` -> `Library`.
2. Search for `Google Calendar API`.
3. Open it and click `Enable`.

This app uses Calendar read and write access because the code requests:

- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.readonly`

### 3. Configure the OAuth consent screen

Google's current flow is under `Google Auth platform`.

1. Go to `Google Auth platform` -> `Branding`.
2. Click `Get started` if the auth platform is not configured yet.
3. Enter:
   - App name: `Calendar Assistant`
   - User support email: your email
4. Continue.
5. For `Audience`, choose `External`.
6. Continue.
7. Add your contact email.
8. Accept the policy and create.

### 4. Add test users

While you are testing, keep the app in testing mode and add yourself as a test user.

1. Go to `Google Auth platform` -> `Audience`.
2. Under `Test users`, click `Add users`.
3. Add the Google account(s) you will use to sign in.

### 5. Add the required scopes

1. Go to `Google Auth platform` -> `Data Access`.
2. Click `Add or Remove Scopes`.
3. Add these scopes:
   - `openid`
   - `.../auth/userinfo.email`
   - `.../auth/userinfo.profile`
   - `https://www.googleapis.com/auth/calendar.events`
   - `https://www.googleapis.com/auth/calendar.readonly`

Notes:

- The OpenID/email/profile scopes are part of Google sign-in.
- The two Calendar scopes are what this app actually uses for listing and creating events.

### 6. Create the OAuth client

1. Go to `APIs & Services` -> `Credentials`.
2. Click `Create Credentials` -> `OAuth client ID`.
3. Choose `Web application`.
4. Give it a name like `Calendar Assistant Web`.

Add these authorized redirect URIs:

- Local development:
  `http://localhost:3000/api/auth/callback/google`
- Vercel production:
  `https://YOUR-PRODUCTION-DOMAIN/api/auth/callback/google`

Examples:

- `https://your-project.vercel.app/api/auth/callback/google`
- `https://calendar.yourdomain.com/api/auth/callback/google`

Then copy:

- `Client ID` -> `GOOGLE_CLIENT_ID`
- `Client secret` -> `GOOGLE_CLIENT_SECRET`

## Exact Vercel setup

### 1. Import the GitHub repo

1. In Vercel, click `Add New...` -> `Project`.
2. Import `CodingGenius0001/Calendar-Assistant`.
3. Keep the framework preset as `Next.js`.
4. Keep the root directory as the repo root.

### 2. Add environment variables

In `Project Settings` -> `Environment Variables`, add:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_SECRET`

Recommended:

- Add those three to `Production`, `Preview`, and `Development`.
- Do not commit them into GitHub.

For `NEXTAUTH_URL`:

- Local only: set `NEXTAUTH_URL=http://localhost:3000` in `.env.local`
- On Vercel: simplest option is to leave it unset and let NextAuth detect the deployment URL
- If you set it manually in Vercel, use your production domain only

### 3. Confirm Vercel settings

In `Project Settings`:

- Framework Preset: `Next.js`
- Production Branch: `main`
- Node install/build commands: leave defaults unless you have a reason to override them

### 4. Get the production domain

After the project is created, Vercel gives you a production domain such as:

```text
https://your-project.vercel.app
```

Use that base URL in the Google redirect URI:

```text
https://your-project.vercel.app/api/auth/callback/google
```

If you later attach a custom domain, add that custom-domain callback URI in Google too.

## Fastest path to test immediately

1. Create the Vercel project from the GitHub repo.
2. Copy the Vercel production domain.
3. Create the Google OAuth client and add both redirect URIs:
   - `http://localhost:3000/api/auth/callback/google`
   - `https://YOUR-PRODUCTION-DOMAIN/api/auth/callback/google`
4. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `NEXTAUTH_SECRET` into Vercel.
5. Redeploy if needed.
6. Visit the production URL and sign in with a Google account that is listed as a test user.
7. Record a prompt and approve it.
8. Book the event and check your Google Calendar.

## Important preview-deployment caveat

Google requires exact redirect URIs. Vercel preview URLs change by branch and commit, so Google sign-in usually should be tested on your stable production domain, not random preview URLs.

In practice:

- Preview deployments should still build fine.
- Google login may fail on preview URLs unless you register that exact preview URL.
- For personal use, test auth on local dev or the production Vercel domain.

## If Google sign-in works but calendar actions fail

The most common causes are:

- The Calendar API is not enabled.
- The wrong Google account is signing in.
- The signing-in account was not added as a test user.
- The redirect URI in Google does not exactly match the deployed domain.
- You signed in before the refresh token settings took effect.

If you changed the Google OAuth settings after already signing in, remove the app from:

`https://myaccount.google.com/permissions`

Then sign in again so Google reissues consent and the refresh token.
