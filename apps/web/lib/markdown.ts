import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "p", "br", "hr",
  "strong", "em", "del", "code", "pre",
  "blockquote",
  "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "a",
  "table", "thead", "tbody", "tr", "th", "td",
];

const ALLOWED_ATTR: Record<string, string[]> = {
  a: ["href", "title", "rel", "target"],
};

const SANITIZE_OPTS: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: ALLOWED_ATTR,
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
  },
};

marked.setOptions({ async: false, gfm: true, breaks: true });

export function renderMarkdown(input: string | null | undefined): string {
  if (!input) return "";
  const raw = marked.parse(input) as string;
  return sanitizeHtml(raw, SANITIZE_OPTS);
}
