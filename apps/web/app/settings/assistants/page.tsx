/**
 * Settings — Assistants page (US-023 / AD-002 / PR2-H).
 *
 * Visible only to exec_all tier. Shows the list of current assistant grants
 * and provides a form to invite a new assistant by email.
 *
 * Revocation is immediate: the grant's revoked_at is set to now() via the
 * revokeAssistant server action.
 */
import { redirect } from "next/navigation";
import { schema } from "@exec-db/db";
import { isNull, eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { inviteAssistant, revokeAssistant } from "./actions";

export const dynamic = "force-dynamic";

export default async function AssistantsPage() {
  const session = await getSession();

  // Page is exec_all only.
  if (!session || session.tier !== "exec_all") {
    redirect("/");
  }

  // Fetch active grants for this exec.
  const grants = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    async (tx) =>
      tx
        .select({
          id: schema.assistantGrant.id,
          assistantUserId: schema.assistantGrant.assistantUserId,
          grantedAt: schema.assistantGrant.grantedAt,
        })
        .from(schema.assistantGrant)
        .where(
          eq(schema.assistantGrant.execUserId, session.userId) &&
            isNull(schema.assistantGrant.revokedAt),
        ),
  );

  return (
    <main style={{ padding: "2rem", maxWidth: "640px" }}>
      <h1>Assistants</h1>
      <p>
        Invite your Chief-of-Staff or EA to read your CRM and PM data. Sensitive-flagged contacts
        remain hidden from assistants.
      </p>

      {/* Current grants */}
      <section style={{ marginTop: "1.5rem" }}>
        <h2>Current assistants</h2>
        {grants.length === 0 ? (
          <p style={{ color: "#6b7280" }}>No assistants have been invited yet.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem" }}>Assistant ID</th>
                <th style={{ textAlign: "left", padding: "0.5rem 0.75rem" }}>Granted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {grants.map((g) => (
                <tr key={g.id} style={{ borderTop: "1px solid #e5e7eb" }}>
                  <td style={{ padding: "0.5rem 0.75rem", fontFamily: "monospace", fontSize: "0.875rem" }}>
                    {g.assistantUserId}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem", fontSize: "0.875rem" }}>
                    {g.grantedAt.toLocaleDateString()}
                  </td>
                  <td style={{ padding: "0.5rem 0.75rem" }}>
                    <form action={revokeAssistant.bind(null, g.id)}>
                      <button
                        type="submit"
                        style={{
                          padding: "0.25rem 0.75rem",
                          background: "#ef4444",
                          color: "white",
                          border: "none",
                          borderRadius: "0.25rem",
                          cursor: "pointer",
                        }}
                      >
                        Revoke
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Invite form */}
      <section style={{ marginTop: "2rem" }}>
        <h2>Invite an assistant</h2>
        <form action={inviteAssistant} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end" }}>
          <div style={{ flex: 1 }}>
            <label htmlFor="email" style={{ display: "block", marginBottom: "0.25rem", fontSize: "0.875rem" }}>
              Work email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              placeholder="assistant@company.com"
              style={{
                width: "100%",
                padding: "0.5rem 0.75rem",
                border: "1px solid #d1d5db",
                borderRadius: "0.25rem",
                fontSize: "0.875rem",
              }}
            />
          </div>
          <button
            type="submit"
            style={{
              padding: "0.5rem 1rem",
              background: "#3b82f6",
              color: "white",
              border: "none",
              borderRadius: "0.25rem",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            Invite
          </button>
        </form>
      </section>
    </main>
  );
}
