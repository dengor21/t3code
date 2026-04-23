import type { FlakeHost, FlakeMetadata } from "@t3tools/contracts";

export const GENERAL_CHANGELOG_PATH = ".t3code/changes.md";
export const HOST_DOCS_DIR = ".t3code/docs/hosts";
export const LEGACY_HOST_DOCS_DIR = ".t3code/hosts";

export interface DocumentationChangeLogEntry {
  readonly id: string;
  readonly kind: "change" | "bootstrap";
  readonly completedAt: string;
  readonly title: string;
  readonly markdown: string;
  readonly hosts: ReadonlyArray<string>;
  readonly ambiguous: boolean;
  readonly files: ReadonlyArray<string>;
}

export interface HostDocumentationFrontmatter {
  readonly generatedAt: string | null;
  readonly coversChangesThrough: string | null;
}

export function slugHostName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "host";
}

export function resolveProjectHosts(
  metadata:
    | FlakeMetadata
    | { host?: FlakeHost | null; hosts?: ReadonlyArray<FlakeHost> }
    | null
    | undefined,
): ReadonlyArray<FlakeHost> {
  const normalizedMetadata = metadata ?? null;
  if (!normalizedMetadata) {
    return [];
  }
  const hosts = normalizedMetadata.hosts ?? [];
  const normalizedHosts =
    hosts.length > 0 ? hosts : normalizedMetadata.host ? [normalizedMetadata.host] : [];
  const seen = new Set<string>();
  return normalizedHosts.filter((host): host is FlakeHost => {
    if (!host) {
      return false;
    }
    const key = host.name.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function splitPathSegments(value: string): ReadonlyArray<string> {
  return value
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0);
}

function stripFileExtension(value: string): string {
  const lastDotIndex = value.lastIndexOf(".");
  return lastDotIndex <= 0 ? value : value.slice(0, lastDotIndex);
}

export function inferHostsFromPaths(input: {
  hosts: ReadonlyArray<FlakeHost>;
  paths: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  if (input.hosts.length === 0 || input.paths.length === 0) {
    return [];
  }
  const changedPathSegments = input.paths.map(splitPathSegments);
  return input.hosts
    .filter((host) => {
      const normalizedHostName = host.name.trim().toLowerCase();
      if (normalizedHostName.length === 0) {
        return false;
      }
      return changedPathSegments.some((segments) =>
        segments.some(
          (segment) =>
            segment === normalizedHostName || stripFileExtension(segment) === normalizedHostName,
        ),
      );
    })
    .map((host) => host.name);
}

function parseFilesLine(value: string): ReadonlyArray<string> {
  const matched = /^Files:\s*(.+)$/m.exec(value)?.[1]?.trim() ?? "";
  if (matched.length === 0) {
    return [];
  }
  return matched
    .split(",")
    .map((entry) => entry.replace(/`/g, "").trim())
    .filter((entry) => entry.length > 0 && !entry.startsWith("+"));
}

function parseCompletedAt(value: string): string | null {
  return /^###\s+([0-9T:.-]+Z)\s+-\s+/m.exec(value)?.[1] ?? null;
}

function parseTitle(value: string): string | null {
  return /^###\s+[0-9T:.-]+Z\s+-\s+(.+)$/m.exec(value)?.[1]?.trim() ?? null;
}

function parseMetadataComment(value: string): {
  hosts: ReadonlyArray<string>;
  ambiguous: boolean;
} | null {
  const jsonText = /<!--\s*t3code:meta\s+(\{[\s\S]*?\})\s*-->/m.exec(value)?.[1] ?? null;
  if (!jsonText) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonText) as {
      hosts?: unknown;
      ambiguous?: unknown;
    };
    const hosts = Array.isArray(parsed.hosts)
      ? parsed.hosts
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
      : [];
    return {
      hosts,
      ambiguous: parsed.ambiguous === true,
    };
  } catch {
    return null;
  }
}

export function parseChangeLogEntries(input: {
  markdown: string;
  hosts: ReadonlyArray<FlakeHost>;
}): ReadonlyArray<DocumentationChangeLogEntry> {
  const entries: DocumentationChangeLogEntry[] = [];
  const blockRegex =
    /<!--\s*t3code:(turn|bootstrap):([^:]+):start\s*-->([\s\S]*?)<!--\s*t3code:\1:\2:end\s*-->/g;
  for (const match of input.markdown.matchAll(blockRegex)) {
    const markerKind = match[1] === "bootstrap" ? "bootstrap" : "change";
    const id = match[2]?.trim() ?? "";
    const block = match[3] ?? "";
    const completedAt = parseCompletedAt(block);
    const title = parseTitle(block);
    if (!completedAt) {
      continue;
    }
    const files = parseFilesLine(block);
    const metadata = parseMetadataComment(block);
    const sanitizedMarkdown = block
      .replace(/<!--\s*t3code:meta\s+\{[\s\S]*?\}\s*-->\n?/g, "")
      .replace(/^###\s+[0-9T:.-]+Z\s+-\s+.+$\n?/m, "")
      .replace(/^Files:\s*.+$/m, "")
      .trim();
    const inferredHosts = metadata?.hosts.length
      ? metadata.hosts
      : inferHostsFromPaths({ hosts: input.hosts, paths: files });
    entries.push({
      id: id.length > 0 ? id : completedAt,
      kind: markerKind,
      completedAt,
      title: title && title.length > 0 ? title : "Untitled change",
      markdown: sanitizedMarkdown,
      hosts: inferredHosts,
      ambiguous: metadata?.ambiguous ?? false,
      files,
    });
  }
  return entries;
}

export function parseHostDocumentationFrontmatter(markdown: string): HostDocumentationFrontmatter {
  const frontmatter = /^---\n([\s\S]*?)\n---/m.exec(markdown)?.[1] ?? "";
  const readScalar = (key: string): string | null =>
    new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontmatter)?.[1]?.trim() ?? null;
  return {
    generatedAt: readScalar("generatedAt"),
    coversChangesThrough: readScalar("coversChangesThrough"),
  };
}

export function stripMarkdownFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n*/m, "").trim();
}

export function renderInlineCodeList(paths: ReadonlyArray<string>): string {
  if (paths.length === 0) {
    return "(none)";
  }
  const visible = paths.slice(0, 8).map((file) => `\`${file}\``);
  const remainder = paths.length - visible.length;
  return remainder > 0
    ? `${visible.join(", ")}, +${remainder.toString()} more`
    : visible.join(", ");
}
