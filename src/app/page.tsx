import { getServerSession } from "next-auth";
import { DashboardShell } from "@/components/dashboard-shell";
import { authOptions } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getServerSession(authOptions);
  const googleConfigured = Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.NEXTAUTH_SECRET,
  );

  return (
    <DashboardShell
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
    />
  );
}
