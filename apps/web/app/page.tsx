import { schema } from "@exec-db/db";
import { count, eq } from "drizzle-orm";
import Link from "next/link";
import { getSession } from "@/lib/auth";
import { query } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function Home(): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) {
    return <p className="text-sm">Sign in required.</p>;
  }

  const ctx = {
    userId: session.userId,
    tier: session.tier,
    functionArea: session.functionArea,
  };

  const counts = await query(ctx, async (tx) => {
    const [c] = await tx.select({ n: count() }).from(schema.contact);
    const [p] = await tx
      .select({ n: count() })
      .from(schema.project)
      .where(eq(schema.project.status, "active"));
    const [d] = await tx
      .select({ n: count() })
      .from(schema.draft)
      .where(eq(schema.draft.status, "pending"));
    return { contacts: c?.n ?? 0, projects: p?.n ?? 0, drafts: d?.n ?? 0 };
  });

  const cards: Array<{ href: string; title: string; subtitle: string; n: number }> = [
    {
      href: "/crm/contacts",
      title: "Contacts (CRM)",
      subtitle: "People and call notes",
      n: counts.contacts,
    },
    {
      href: "/pm/projects",
      title: "Active projects (PM)",
      subtitle: "Projects and tasks",
      n: counts.projects,
    },
    {
      href: "/crm/contacts",
      title: "Drafts pending review",
      subtitle: "Autodrafted follow-ups awaiting your call",
      n: counts.drafts,
    },
  ];

  return (
    <div className="space-y-8">
      <section>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Signed in as {session.email} ({session.tier})
        </p>
      </section>

      <section className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <Link
            key={c.title}
            href={c.href}
            className="rounded-md border border-neutral-200 p-4 hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
          >
            <div className="text-3xl font-semibold">{c.n}</div>
            <div className="mt-1 text-sm font-medium">{c.title}</div>
            <div className="text-xs text-neutral-500">{c.subtitle}</div>
          </Link>
        ))}
      </section>
    </div>
  );
}
