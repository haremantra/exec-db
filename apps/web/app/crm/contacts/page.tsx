import { schema } from "@exec-db/db";
import { desc } from "drizzle-orm";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { createContact } from "./actions";

export const dynamic = "force-dynamic";

export default async function ContactsPage(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const contacts = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    (tx) =>
      tx
        .select()
        .from(schema.contact)
        .orderBy(desc(schema.contact.updatedAt))
        .limit(200),
  );

  const canWrite = session.tier === "exec_all";

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Contacts</h2>
        <span className="text-xs text-neutral-500">{contacts.length} shown</span>
      </header>

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
