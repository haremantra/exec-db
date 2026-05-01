import { getSession } from "@/lib/auth";

const QUESTIONS: Array<{ id: string; title: string; tier: string; phase: number }> = [
  { id: "runway", title: "Runway at current burn vs. plan", tier: "exec_all", phase: 1 },
  { id: "headcount", title: "Headcount: actual vs. plan, by function & quarter", tier: "exec_all", phase: 1 },
  { id: "comp-bands", title: "Comp band drift / outliers >1.5σ from band mid", tier: "exec_all", phase: 2 },
  { id: "renewals", title: "Contract renewals in next 90 days, by ARR risk", tier: "function_lead", phase: 3 },
  { id: "vendor-spend", title: "Top 10 vendors by spend, MoM change", tier: "exec_all", phase: 1 },
  { id: "funnel", title: "Hiring funnel conversion by stage & source", tier: "function_lead", phase: 1 },
  { id: "ndr", title: "Net dollar retention & gross margin trend", tier: "exec_all", phase: 4 },
  { id: "okrs", title: "OKR progress (R/Y/G)", tier: "function_lead", phase: 4 },
];

export default async function Home(): Promise<JSX.Element> {
  const session = await getSession();

  return (
    <div className="space-y-8">
      <section>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          {session
            ? `Signed in as ${session.email} (${session.tier})`
            : "Not signed in — using stub session"}
        </p>
      </section>

      <section>
        <h2 className="mb-3 text-base font-medium">Exec questions</h2>
        <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
          {QUESTIONS.map((q) => (
            <li key={q.id} className="flex items-center justify-between px-4 py-3 text-sm">
              <span>{q.title}</span>
              <span className="flex gap-2 text-xs text-neutral-500">
                <span className="rounded border border-neutral-300 px-2 py-0.5 dark:border-neutral-700">
                  {q.tier}
                </span>
                <span className="rounded border border-neutral-300 px-2 py-0.5 dark:border-neutral-700">
                  Phase {q.phase}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
