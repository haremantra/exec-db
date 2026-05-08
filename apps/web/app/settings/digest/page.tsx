/**
 * Settings — Digest preferences page (PR3-O / S5.2).
 *
 * Visible to all signed-in users (any tier). Shows the current opt-in status
 * for daily and weekly digests and provides checkboxes to toggle them.
 *
 * Digest emails are sent via Resend, not Gmail (S5.1 / S6.5).
 * Schedule: 7:00 am America/Los_Angeles (14:00 UTC during PDT).
 */
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { schema } from "@exec-db/db";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { setDigestOptin } from "./actions";

export const dynamic = "force-dynamic";

export default async function DigestSettingsPage() {
  const session = await getSession();

  if (!session) {
    redirect("/");
  }

  // Fetch current preferences (may not exist yet if user has never set them).
  const prefs = await query(
    {
      userId: session.userId,
      tier: session.tier,
      functionArea: session.functionArea,
    },
    async (tx) =>
      tx
        .select({
          digestDailyOptin: schema.userPref.digestDailyOptin,
          digestWeeklyOptin: schema.userPref.digestWeeklyOptin,
        })
        .from(schema.userPref)
        .where(eq(schema.userPref.userId, session.userId))
        .limit(1),
  );

  const currentPrefs = prefs[0] ?? {
    digestDailyOptin: false,
    digestWeeklyOptin: false,
  };

  return (
    <main style={{ padding: "2rem", maxWidth: "480px" }}>
      <h1>Digest settings</h1>
      <p style={{ color: "#6b7280", fontSize: "0.875rem" }}>
        exec-db digest emails are sent at 7:00 am Pacific Time via Resend.
        Daily digests arrive Monday–Friday; the weekly digest arrives Sunday.
      </p>

      <form action={setDigestOptin} style={{ marginTop: "1.5rem" }}>
        {/* Daily opt-in */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            name="daily"
            defaultChecked={currentPrefs.digestDailyOptin}
            style={{ width: "1rem", height: "1rem" }}
          />
          <span>
            <strong>Daily digest</strong>
            <br />
            <span style={{ color: "#6b7280", fontSize: "0.875rem" }}>
              Your active tasks, every weekday morning.
            </span>
          </span>
        </label>

        {/* Weekly opt-in */}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            marginBottom: "1.5rem",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            name="weekly"
            defaultChecked={currentPrefs.digestWeeklyOptin}
            style={{ width: "1rem", height: "1rem" }}
          />
          <span>
            <strong>Weekly digest</strong>
            <br />
            <span style={{ color: "#6b7280", fontSize: "0.875rem" }}>
              Active tasks + tasks completed this week, every Sunday.
            </span>
          </span>
        </label>

        <button
          type="submit"
          style={{
            padding: "0.5rem 1.25rem",
            background: "#3b82f6",
            color: "white",
            border: "none",
            borderRadius: "0.25rem",
            cursor: "pointer",
            fontSize: "0.875rem",
          }}
        >
          Save preferences
        </button>
      </form>

      <p style={{ marginTop: "1.5rem", fontSize: "0.8rem", color: "#9ca3af" }}>
        To unsubscribe, click the unsubscribe link in any digest email or
        uncheck both boxes above.
      </p>
    </main>
  );
}
