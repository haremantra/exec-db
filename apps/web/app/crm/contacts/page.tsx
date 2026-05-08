import { schema } from "@exec-db/db";
import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import {
  createContact,
  quickAddFromLinkedIn,
  confirmDraftContact,
  discardDraftContact,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ContactsPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const allContacts = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    (tx) =>
      tx
        .select()
        .from(schema.contact)
        .orderBy(desc(schema.contact.updatedAt))
        .limit(200),
  );

  const drafts = allContacts.filter((c) => c.isDraft);
  const contacts = allContacts.filter((c) => !c.isDraft);

  const canWrite = session.tier === "exec_all";

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Contacts</h2>
        <span className="text-xs text-neutral-500">{contacts.length} shown</span>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Drafts pending review (G4 — US-005)                                 */}
      {/* ------------------------------------------------------------------ */}
      {canWrite && drafts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-amber-600 dark:text-amber-400">
            Drafts pending review ({drafts.length})
          </h3>
          <ul className="divide-y divide-neutral-200 rounded-md border border-amber-300 dark:divide-neutral-700 dark:border-amber-700">
            {drafts.map((c) => {
              const confirmAction = confirmDraftContact.bind(null, c.id);
              const discardAction = discardDraftContact.bind(null, c.id);
              return (
                <li
                  key={c.id}
                  className="flex items-center justify-between px-4 py-3 text-sm"
                >
                  <Link
                    href={`/crm/contacts/${c.id}`}
                    className="flex min-w-0 flex-1 items-baseline gap-2"
                  >
                    <span className="font-medium">{c.fullName}</span>
                    <span className="truncate text-neutral-500">{c.primaryEmail}</span>
                    {c.company && (
                      <span className="text-xs text-neutral-400">{c.company}</span>
                    )}
                  </Link>
                  <span className="ml-4 flex shrink-0 gap-2">
                    <form action={confirmAction}>
                      <button
                        type="submit"
                        className="rounded bg-emerald-600 px-2 py-1 text-xs text-white hover:bg-emerald-700"
                      >
                        Confirm
                      </button>
                    </form>
                    <form action={discardAction}>
                      <button
                        type="submit"
                        className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                      >
                        Discard
                      </button>
                    </form>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* LinkedIn quick-add (G1 — US-005)                                    */}
      {/* ------------------------------------------------------------------ */}
      {canWrite && (
        <form
          action={quickAddFromLinkedIn}
          className="flex gap-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800"
        >
          <input
            name="linkedinUrl"
            placeholder="Paste a LinkedIn URL to draft a contact"
            className="min-w-0 flex-1 rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            className="shrink-0 rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-700"
          >
            Quick-add
          </button>
        </form>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Full create form                                                     */}
      {/* ------------------------------------------------------------------ */}
      {canWrite && (
        <form
          action={createContact}
          className="grid grid-cols-2 gap-3 rounded-md border border-neutral-200 p-4 dark:border-neutral-800"
        >
          <input
            name="fullName"
            placeholder="Full name"
            required
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <input
            name="primaryEmail"
            type="email"
            placeholder="email@company.com"
            required
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <input
            name="company"
            placeholder="Company"
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <input
            name="roleTitle"
            placeholder="Role / title"
            className="rounded border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <button
            type="submit"
            className="col-span-2 rounded bg-neutral-900 px-3 py-1.5 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Add contact
          </button>
        </form>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Confirmed contacts list                                              */}
      {/* ------------------------------------------------------------------ */}
      <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
        {contacts.length === 0 && (
          <li className="px-4 py-6 text-sm text-neutral-500">No contacts yet.</li>
        )}
        {contacts.map((c) => (
          <li key={c.id} className="px-4 py-3 text-sm">
            <Link href={`/crm/contacts/${c.id}`} className="flex items-baseline justify-between">
              <span>
                <span className="font-medium">{c.fullName}</span>
                <span className="ml-2 text-neutral-500">{c.primaryEmail}</span>
              </span>
              <span className="text-xs text-neutral-500">
                {c.company ?? ""} {c.roleTitle ? `· ${c.roleTitle}` : ""}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
