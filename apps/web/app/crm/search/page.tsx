/**
 * /crm/search — Full-text call-note search (I2 — US-008, W3.6).
 *
 * URL: /crm/search?q=…&includeSensitive=1
 *
 * - Input field "Search call notes".
 * - Checkbox "Include sensitive (exec only)" — ignored for non-exec_all sessions.
 * - Results: contact name + 2-line snippet around the match + "View contact" link.
 * - Sensitive contacts excluded by default; included only when the checkbox is
 *   checked AND the session tier is exec_all.
 * - Limit: 50 results, ordered by occurred_at DESC.
 * - No LLM calls — ILIKE matching only.
 */

import Link from "next/link";
import { getSession } from "@/lib/auth";
import { searchCallNotes } from "@/lib/note-search";

export const dynamic = "force-dynamic";

interface SearchParams {
  q?: string;
  includeSensitive?: string;
}

/** Highlight **bold** markers in a snippet as <mark> elements. */
function SnippetDisplay({ snippet }: { snippet: string }): JSX.Element {
  // The snippet uses **matched** to mark the hit span.  Split on ** pairs and
  // render alternating plain/highlighted segments.
  const parts = snippet.split(/\*\*(.*?)\*\*/g);
  return (
    <span>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-700 rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}): Promise<JSX.Element> {
  const session = await getSession();
  if (!session) return <p className="text-sm">Sign in required.</p>;

  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const includeSensitive = params.includeSensitive === "1";
  const isExec = session.tier === "exec_all";

  // Run search only when a non-empty query is present.
  const results =
    q.length > 0
      ? await searchCallNotes(q, session, {
          includeSensitive: includeSensitive && isExec,
          limit: 50,
        })
      : null;

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-medium">Search call notes</h2>
        <p className="text-xs text-neutral-500 mt-1">
          Searches the full text of all call notes. Sensitive contacts are excluded
          by default.
        </p>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Search form                                                          */}
      {/* ------------------------------------------------------------------ */}
      <form method="GET" className="space-y-3">
        <div className="flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder='e.g. "update request" or "delivered when"'
            autoFocus
            className="min-w-0 flex-1 rounded border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {/* Note: includeSensitive value is carried by the checkbox below
              when the toggle is rendered. We deliberately do NOT mirror it
              into a hidden input — duplicate submissions caused
              `params.includeSensitive` to deserialise as a string[] in
              Next.js, breaking the toggle. */}
          <button
            type="submit"
            className="shrink-0 rounded bg-neutral-900 px-4 py-2 text-sm text-white dark:bg-neutral-100 dark:text-neutral-900"
          >
            Search
          </button>
        </div>

        {/* Include-sensitive toggle — only rendered for exec_all */}
        {isExec && (
          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400 cursor-pointer">
            <input
              type="checkbox"
              name="includeSensitive"
              value="1"
              defaultChecked={includeSensitive}
              className="rounded border-neutral-300"
            />
            Include sensitive contacts (exec only)
          </label>
        )}
      </form>

      {/* ------------------------------------------------------------------ */}
      {/* Results                                                              */}
      {/* ------------------------------------------------------------------ */}
      {results === null && (
        <p className="text-sm text-neutral-500">
          Enter a keyword to search across all call notes.
        </p>
      )}

      {results !== null && results.length === 0 && (
        <p className="text-sm text-neutral-500">
          No notes matched <strong>&ldquo;{q}&rdquo;</strong>
          {!includeSensitive && isExec && " (sensitive contacts excluded — check the box above to include them)"}
          {!includeSensitive && !isExec && " (sensitive contacts always excluded for non-exec users)"}.
        </p>
      )}

      {results !== null && results.length > 0 && (
        <section className="space-y-1">
          <p className="text-xs text-neutral-500">
            {results.length} result{results.length !== 1 ? "s" : ""} for{" "}
            <strong>&ldquo;{q}&rdquo;</strong>
            {includeSensitive && isExec && " (including sensitive)"}
          </p>
          <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {results.map((r) => (
              <li key={r.noteId} className="px-4 py-3 space-y-1">
                {/* Contact name + date */}
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-medium">{r.contactName}</span>
                  <span className="text-xs text-neutral-500">
                    {r.occurredAt.toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                </div>

                {/* 2-line snippet with highlighted match */}
                <p className="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-2 font-mono">
                  <SnippetDisplay snippet={r.snippet} />
                </p>

                {/* View contact link */}
                <Link
                  href={`/crm/contacts/${r.contactId}`}
                  className="text-xs text-sky-600 hover:underline dark:text-sky-400"
                >
                  View contact →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
