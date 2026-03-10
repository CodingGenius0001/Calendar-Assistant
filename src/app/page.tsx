import { getServerSession } from "next-auth";
import { DashboardShell } from "@/components/dashboard-shell";
import { authOptions } from "@/lib/auth";
import { listUpcomingEvents } from "@/lib/google";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession(authOptions);
  const googleConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.NEXTAUTH_SECRET,
  );

  let upcomingEvents: Awaited<ReturnType<typeof listUpcomingEvents>> = [];
  let calendarError: string | null = null;

  if (session?.accessToken) {
    try {
      upcomingEvents = await listUpcomingEvents(session.accessToken);
    } catch {
      calendarError =
        "I couldn't load your upcoming Google Calendar items. Reconnect Google if the token expired.";
    }
  }

  return (
    <DashboardShell
      calendarError={calendarError}
      googleConfigured={googleConfigured}
      session={
        session
          ? {
              error: session.error ?? null,
              user: {
                email: session.user?.email ?? null,
                image: session.user?.image ?? null,
                name: session.user?.name ?? null,
              },
            }
          : null
      }
      upcomingEvents={upcomingEvents}
    />
  );
}
