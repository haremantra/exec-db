/**
 * Google Calendar sync.
 *
 * Pulls events from the user's primary calendar and inserts them into
 * crm.calendar_event. Idempotent on google_event_id.
 *
 * Attendees are matched against crm.contact.primary_email (simple equality, S6.9).
 */
import { google } from "googleapis";
import { sql } from "drizzle-orm";
import { getDb } from "@exec-db/db";
import { googleClientForUser } from "./google.js";

interface SyncCalendarOptions {
  since?: Date;
}

interface SyncCalendarResult {
  ingested: number;
}

const DEFAULT_DAYS_PAST = 30;
const DEFAULT_DAYS_FUTURE = 30;
const MAX_RESULTS = 250;

/**
 * Syncs calendar events for a user into crm.calendar_event.
 *
 * Default window: last 30 days + next 30 days.
 * Idempotent: uses ON CONFLICT (google_event_id) DO NOTHING.
 */
export async function syncCalendarEventsForUser(
  userId: string,
  options: SyncCalendarOptions = {},
): Promise<SyncCalendarResult> {
  try {
    const authClient = await googleClientForUser(userId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calendar = google.calendar({ version: "v3", auth: authClient as any });

    const now = new Date();
    const timeMin = options.since ?? new Date(now.getTime() - DEFAULT_DAYS_PAST * 86_400_000);
    const timeMax = new Date(now.getTime() + DEFAULT_DAYS_FUTURE * 86_400_000);

    const db = getRawDb();
    let ingested = 0;
    let pageToken: string | undefined;

    do {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response: any = await (calendar.events.list as any)({
        calendarId: "primary",
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        maxResults: MAX_RESULTS,
        singleEvents: true,
        orderBy: "startTime",
        ...(pageToken ? { pageToken } : {}),
      });

      const events: Array<{
        id?: string | null;
        summary?: string | null;
        start?: { dateTime?: string | null; date?: string | null } | null;
        end?: { dateTime?: string | null; date?: string | null } | null;
        attendees?: Array<{ email?: string | null; displayName?: string | null; responseStatus?: string | null }> | null;
      }> = response.data?.items ?? [];
      pageToken = (response.data?.nextPageToken as string | undefined) ?? undefined;

      for (const event of events) {
        if (!event.id) continue;

        const attendees = (event.attendees ?? []).map((a) => ({
          email: a.email,
          displayName: a.displayName,
          responseStatus: a.responseStatus,
        }));

        // Try to match an attendee to crm.contact
        // RowList extends the rows array directly — use index access.
        let contactId: string | null = null;
        for (const attendee of attendees) {
          if (!attendee.email) continue;
          const contactResult = await db.execute(sql`
            SELECT id FROM crm.contact
            WHERE primary_email = ${attendee.email}
            LIMIT 1
          `);
          const contactRows = contactResult as unknown as Array<{ id: string }>;
          if (contactRows.length > 0) {
            contactId = contactRows[0]!.id;
            break;
          }
        }

        const startsAt =
          event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
        const endsAt =
          event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00Z` : null);

        await db.execute(sql`
          INSERT INTO crm.calendar_event
            (google_event_id, contact_id, title, starts_at, ends_at, attendees,
             _ingested_at, _source_system, _source_id, _valid_from)
          VALUES (
            ${event.id},
            ${contactId}::uuid,
            ${event.summary ?? null},
            ${startsAt}::timestamptz,
            ${endsAt}::timestamptz,
            ${JSON.stringify(attendees)}::jsonb,
            now(),
            'google_calendar',
            ${event.id},
            now()
          )
          ON CONFLICT (google_event_id) DO NOTHING
        `);

        ingested++;
      }
    } while (pageToken);

    return { ingested };
  } catch (err) {
    console.error("[google-calendar] syncCalendarEventsForUser failed:", err);
    throw new Error(
      `Calendar sync failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function getRawDb() {
  const url = process.env.DATABASE_URL_APP ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_APP (or DATABASE_URL) is required");
  return getDb(url);
}
