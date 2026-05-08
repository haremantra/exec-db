import { schema, TRIAGE_TAG_VALUES, WORK_AREA_VALUES } from "@exec-db/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";
import { createContact } from "./actions";

export const dynamic = "force-dynamic";

/** Human-readable labels for triage tags. */
const TRIAGE_LABELS: Record<string, string> = {
  can_help_them: "Can Help Them",
  can_help_me: "Can Help Me",
  pilot_candidate: "Pilot Candidate",
};

/** Human-readable labels for work-area tags. */
const WORK_AREA_LABELS: Record<string, string> = {
  prospecting: "Prospecting",
  customer: "Customer",
  investor: "Investor",
  contractor: "Contractor",
  board: "Board",
  thought_leadership: "Thought Leadership",
  admin: "Admin",
};

interface SearchParams {
  triage?: string;
  workArea?: string;
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const params = await searchParams;
  const triageFilter = TRIAGE_TAG_VALUES.includes(
    params.triage as (typeof TRIAGE_TAG_VALUES)[number],
  )
    ? (params.triage as (typeof TRIAGE_TAG_VALUES)[number])
    : null;
  const workAreaFilter = WORK_AREA_VALUES.includes(
    params.workArea as (typeof WORK_AREA_VALUES)[number],
  )
    ? (params.workArea as (typeof WORK_AREA_VALUES)[number])
    : null;

  const allContacts = await query(
    { userId: session.userId, tier: session.tier, functionArea: session.functionArea },
    (tx) => {
      // Build a where clause based on active filters.
      // isDraft check is deferred to JS-side since isDraft column only exists
      // after the G stream merges; we filter in-memory for safety.
      const conditions = [];
      if (triageFilter) {
        conditions.push(eq(schema.contact.triageTag, triageFilter));
      }
      if (workAreaFilter) {
        conditions.push(eq(schema.contact.workArea, workAreaFilter));
      }

      const base = tx
        .select()
        .from(schema.contact)
        .orderBy(desc(schema.contact.updatedAt))
        .limit(200);

      if (conditions.length === 0) return base;
      return base.where(and(...conditions));
    },
  );

  // Split draft vs confirmed contacts.
  // isDraft column added by G stream (claude/pr2-G-quick-add).
  // Safe-fallback: if the column is absent, treat all as confirmed.
  const drafts = allContacts.filter(
    (c) => (c as { isDraft?: boolean }).isDraft === true,
  );
  const contacts = allContacts.filter(
    (c) => (c as { isDraft?: boolean }).isDraft !== true,
  );

  const canWrite = session.tier === "exec_all";

  // Build the base URL for filter chip hrefs (strips page-level params).
  const buildUrl = (extra: Record<string, string | null>) => {
    const p: Record<string, string> = {};
    if (triageFilter) p.triage = triageFilter;
    if (workAreaFilter) p.workArea = workAreaFilter;
    Object.entries(extra).forEach(([k, v]) => {
      if (v === null) {
        delete p[k];
      } else {
        p[k] = v;
      }
    });
    const qs = new URLSearchParams(p).toString();
    return qs ? `/crm/contacts?${qs}` : "/crm/contacts";
  };

  return (
    <div className="space-y-6">
      <header className="flex items-baseline justify-between">
        <h2 className="text-base font-medium">Contacts</h2>
        <span className="text-xs text-neutral-500">{contacts.length} shown</span>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Drafts pending review (G4 — US-005, preserved for G stream compat)  */}
      {/* ------------------------------------------------------------------ */}
      {canWrite && drafts.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-medium text-amber-600 dark:text-amber-400">
            Drafts pending review ({drafts.length})
          </h3>
          <ul className="divide-y divide-neutral-200 rounded-md border border-amber-300 dark:divide-neutral-700 dark:border-amber-700">
            {drafts.map((c) => (
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
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Filter chips — triage tag + work area (I1/I3 — US-007, US-001)     */}
      {/* ------------------------------------------------------------------ */}
      <section className="space-y-2">
        {/* Triage tag chips */}
        <div className="flex flex-wrap gap-2">
          <span className="text-xs font-medium text-neutral-500 self-center">Triage:</span>
          <Link
            href={buildUrl({ triage: null })}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              !triageFilter
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            All
          </Link>
          {TRIAGE_TAG_VALUES.map((tag) => (
            <Link
              key={tag}
              href={buildUrl({ triage: triageFilter === tag ? null : tag })}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                triageFilter === tag
                  ? "bg-sky-600 text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {TRIAGE_LABELS[tag] ?? tag}
            </Link>
          ))}
        </div>

        {/* Work-area chips */}
        <div className="flex flex-wrap gap-2">
          <span className="text-xs font-medium text-neutral-500 self-center">Area:</span>
          <Link
            href={buildUrl({ workArea: null })}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              !workAreaFilter
                ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            All
          </Link>
          {WORK_AREA_VALUES.map((area) => (
            <Link
              key={area}
              href={buildUrl({ workArea: workAreaFilter === area ? null : area })}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                workAreaFilter === area
                  ? "bg-emerald-600 text-white"
                  : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300"
              }`}
            >
              {WORK_AREA_LABELS[area] ?? area}
            </Link>
          ))}
        </div>
      </section>

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
          <li className="px-4 py-6 text-sm text-neutral-500">
            {triageFilter || workAreaFilter ? "No contacts match the active filters." : "No contacts yet."}
          </li>
        )}
        {contacts.map((c) => (
          <li key={c.id} className="px-4 py-3 text-sm">
            <Link href={`/crm/contacts/${c.id}`} className="flex items-baseline justify-between">
              <span>
                <span className="font-medium">{c.fullName}</span>
                <span className="ml-2 text-neutral-500">{c.primaryEmail}</span>
              </span>
              <span className="flex items-baseline gap-2 text-xs text-neutral-500">
                <span>{c.company ?? ""}{c.roleTitle ? ` · ${c.roleTitle}` : ""}</span>
                {c.triageTag && (
                  <span className="rounded bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-900 dark:text-sky-300">
                    {TRIAGE_LABELS[c.triageTag] ?? c.triageTag}
                  </span>
                )}
                {c.workArea && (
                  <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300">
                    {WORK_AREA_LABELS[c.workArea] ?? c.workArea}
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
