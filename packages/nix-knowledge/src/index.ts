import {
  type NixDesignerScope,
  type NixDiagnostic,
  type NixOptionDoc,
  type NixPackageDoc,
} from "@t3tools/contracts";
import { normalizeSearchQuery, scoreQueryMatch } from "@t3tools/shared/searchRanking";

export const NIX_DESIGNER_INDEX_SCHEMA_VERSION = 1;

export interface LockedNixpkgsRevision {
  readonly revision: string;
  readonly channel: string | null;
  readonly flakeRef: string;
}

export interface NixDesignerIndexManifest {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly channel: string | null;
  readonly builtAt: string;
  readonly optionCount: number;
  readonly packageCount: number;
  readonly lastError: string | null;
  readonly staleReason: string | null;
}

interface SearchDocument {
  readonly key: string;
  readonly haystack: string;
  readonly tokens: ReadonlyArray<string>;
}

export interface SearchIndex<TDocument> {
  readonly documents: ReadonlyArray<TDocument>;
  readonly searchDocuments: ReadonlyArray<SearchDocument>;
  readonly avgDocLength: number;
  readonly termFrequencies: ReadonlyArray<ReadonlyMap<string, number>>;
  readonly inverseDocumentFrequency: ReadonlyMap<string, number>;
  readonly prefixIndex: ReadonlyMap<string, ReadonlyArray<number>>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringArray(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => trimToNull(typeof entry === "string" ? entry : asRecord(entry)?.name))
    .filter((entry): entry is string => entry !== null);
}

function asNodeRecord(value: unknown): Record<string, Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      const record = asRecord(entry);
      return record ? [[key, record]] : [];
    }),
  );
}

function lockedNodeToFlakeRef(node: Record<string, unknown> | null): string {
  const locked = asRecord(node?.locked);
  const owner = trimToNull(locked?.owner);
  const repo = trimToNull(locked?.repo);
  const revision = trimToNull(locked?.rev);
  const type = trimToNull(locked?.type);

  if (type === "github" && owner && repo && revision) {
    return `github:${owner}/${repo}/${revision}`;
  }

  const path = trimToNull(locked?.path);
  if (type === "path" && path) {
    return path.startsWith("path:") ? path : `path:${path}`;
  }

  const url = trimToNull(locked?.url);
  if (url) {
    if (revision && !url.includes("?rev=") && !url.includes("&rev=")) {
      return `${url}${url.includes("?") ? "&" : "?"}rev=${revision}`;
    }
    return url;
  }

  return revision ? `github:NixOS/nixpkgs/${revision}` : "nixpkgs";
}

function normalizeNixText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_#[\](){}:,;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): ReadonlyArray<string> {
  return normalizeNixText(value)
    .split(/[^a-z0-9+._-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function buildPrefixIndex(
  documents: ReadonlyArray<SearchDocument>,
): Map<string, ReadonlyArray<number>> {
  const prefixIndex = new Map<string, number[]>();
  documents.forEach((document, documentIndex) => {
    for (const token of document.tokens) {
      const limit = Math.min(token.length, 32);
      for (let size = 1; size <= limit; size += 1) {
        const prefix = token.slice(0, size);
        const existing = prefixIndex.get(prefix);
        if (existing) {
          if (!existing.includes(documentIndex)) {
            existing.push(documentIndex);
          }
        } else {
          prefixIndex.set(prefix, [documentIndex]);
        }
      }
    }
  });
  return prefixIndex;
}

export function resolveLockedNixpkgsRevision(metadata: unknown): LockedNixpkgsRevision {
  const root = asRecord(metadata);
  const nodeRecord = asNodeRecord(asRecord(asRecord(root?.locks)?.nodes));
  const rootNode = nodeRecord.root ?? null;
  const rootInputs = asRecord(rootNode?.inputs);
  const preferredInputName = trimToNull(rootInputs?.nixpkgs);
  const referencedNixpkgs =
    preferredInputName && preferredInputName in nodeRecord ? nodeRecord[preferredInputName]! : null;
  const namedNixpkgs = nodeRecord.nixpkgs ?? null;
  const selectedNode =
    referencedNixpkgs ??
    namedNixpkgs ??
    Object.values(nodeRecord).find((entry) => {
      const locked = asRecord(entry.locked);
      return locked?.repo === "nixpkgs" && locked.owner === "NixOS";
    }) ??
    null;
  const selected = asRecord(selectedNode);
  const locked = asRecord(selected?.locked);
  const original = asRecord(selected?.original);

  const revision = trimToNull(locked?.rev) ?? trimToNull(root?.revision) ?? "nixpkgs";
  const channel = trimToNull(original?.ref);

  return {
    revision,
    channel,
    flakeRef: lockedNodeToFlakeRef(selected),
  };
}

export function normalizeNixOptionDocs(raw: unknown): ReadonlyArray<NixOptionDoc> {
  const entries = Object.entries(asRecord(raw) ?? {});
  return entries
    .map(([name, value]) => {
      const record = asRecord(value);
      const description =
        trimToNull(record?.description) ??
        trimToNull(record?.text) ??
        trimToNull(record?.example) ??
        "";
      const optionDoc: {
        name: string;
        description: string;
        declarations: ReadonlyArray<string>;
        type?: string;
        default?: string;
        example?: string;
        sourcePath?: string;
      } = {
        name,
        description,
        declarations: toStringArray(record?.declarations),
      };
      const type = trimToNull(record?.type);
      const defaultValue = trimToNull(record?.default);
      const example = trimToNull(record?.example);
      const sourcePath = trimToNull(record?.loc);
      if (type) {
        optionDoc.type = type;
      }
      if (defaultValue) {
        optionDoc.default = defaultValue;
      }
      if (example) {
        optionDoc.example = example;
      }
      if (sourcePath) {
        optionDoc.sourcePath = sourcePath;
      }
      return optionDoc;
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function normalizeNixPackageDocs(raw: unknown): ReadonlyArray<NixPackageDoc> {
  const entries = Object.entries(asRecord(raw) ?? {});
  return entries
    .map(([attr, value]) => {
      const record = asRecord(value);
      const licenseValue = record?.license;
      const licenseRecord = asRecord(licenseValue);
      const licenseFullName = trimToNull(licenseRecord?.fullName);
      const licenses = Array.isArray(licenseValue)
        ? toStringArray(licenseValue)
        : trimToNull(licenseValue)
          ? [trimToNull(licenseValue)!]
          : licenseFullName
            ? [licenseFullName]
            : toStringArray(licenseValue);

      const packageDoc: {
        attr: string;
        license: ReadonlyArray<string>;
        pname?: string;
        version?: string;
        description?: string;
      } = {
        attr,
        license: licenses,
      };
      const pname = trimToNull(record?.pname);
      const version = trimToNull(record?.version);
      const description = trimToNull(record?.description);
      if (pname) {
        packageDoc.pname = pname;
      }
      if (version) {
        packageDoc.version = version;
      }
      if (description) {
        packageDoc.description = description;
      }
      return packageDoc;
    })
    .toSorted((left, right) => left.attr.localeCompare(right.attr));
}

function buildSearchDocuments<TDocument>(
  documents: ReadonlyArray<TDocument>,
  toSearchFields: (document: TDocument) => { key: string; searchText: string },
): ReadonlyArray<SearchDocument> {
  return documents.map((document) => {
    const fields = toSearchFields(document);
    return {
      key: fields.key,
      haystack: normalizeNixText(fields.searchText),
      tokens: tokenize(fields.searchText),
    } satisfies SearchDocument;
  });
}

export function buildSearchIndex<TDocument>(
  documents: ReadonlyArray<TDocument>,
  toSearchFields: (document: TDocument) => { key: string; searchText: string },
): SearchIndex<TDocument> {
  const searchDocuments = buildSearchDocuments(documents, toSearchFields);
  const termFrequencies = searchDocuments.map((document) => {
    const frequencies = new Map<string, number>();
    for (const token of document.tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    return frequencies;
  });
  const documentFrequency = new Map<string, number>();
  for (const frequencies of termFrequencies) {
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const documentCount = Math.max(searchDocuments.length, 1);
  const avgDocLength =
    searchDocuments.reduce((total, document) => total + document.tokens.length, 0) / documentCount;
  const inverseDocumentFrequency = new Map<string, number>();
  for (const [term, frequency] of documentFrequency.entries()) {
    inverseDocumentFrequency.set(
      term,
      Math.log(1 + (documentCount - frequency + 0.5) / (frequency + 0.5)),
    );
  }

  return {
    documents,
    searchDocuments,
    avgDocLength,
    termFrequencies,
    inverseDocumentFrequency,
    prefixIndex: buildPrefixIndex(searchDocuments),
  };
}

function scoreBm25<TDocument>(
  index: SearchIndex<TDocument>,
  documentIndex: number,
  queryTokens: ReadonlyArray<string>,
): number {
  const k1 = 1.2;
  const b = 0.75;
  const frequencies = index.termFrequencies[documentIndex];
  const docLength = index.searchDocuments[documentIndex]?.tokens.length ?? 0;
  let score = 0;
  for (const token of queryTokens) {
    const frequency = frequencies?.get(token) ?? 0;
    if (frequency <= 0) {
      continue;
    }
    const idf = index.inverseDocumentFrequency.get(token) ?? 0;
    const numerator = frequency * (k1 + 1);
    const denominator =
      frequency + k1 * (1 - b + b * (docLength / Math.max(index.avgDocLength, 1)));
    score += idf * (numerator / Math.max(denominator, 1e-6));
  }
  return score;
}

export function searchIndexDocuments<TDocument>(
  index: SearchIndex<TDocument>,
  query: string,
  options?: {
    readonly limit?: number;
    readonly toSearchFields?: (document: TDocument) => { key: string; searchText: string };
  },
): ReadonlyArray<TDocument> {
  const limit = options?.limit ?? 10;
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) {
    return index.documents.slice(0, limit);
  }

  const queryTokens = tokenize(normalizedQuery);
  const prefixMatches = new Set(index.prefixIndex.get(normalizedQuery) ?? []);
  const ranked = index.documents
    .map((document, documentIndex) => {
      const searchDocument = index.searchDocuments[documentIndex];
      if (!searchDocument) {
        return {
          document,
          score: 0,
          key: String(documentIndex),
        };
      }
      const baseScore =
        1_000 -
        (scoreQueryMatch({
          value: searchDocument.haystack,
          query: normalizedQuery,
          exactBase: 0,
          prefixBase: 20,
          boundaryBase: 80,
          includesBase: 120,
          fuzzyBase: 180,
        }) ?? 260);
      const prefixScore = prefixMatches.has(documentIndex) ? 120 : 0;
      const bm25Score = scoreBm25(index, documentIndex, queryTokens) * 100;
      return {
        document,
        score: baseScore + prefixScore + bm25Score,
        key: searchDocument.key,
      };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score || left.key.localeCompare(right.key));

  return ranked.slice(0, limit).map((entry) => entry.document);
}

export function searchOptionDocs(
  index: SearchIndex<NixOptionDoc>,
  query: string,
  limit = 10,
): ReadonlyArray<NixOptionDoc> {
  return searchIndexDocuments(index, query, { limit });
}

export function searchPackageDocs(
  index: SearchIndex<NixPackageDoc>,
  query: string,
  limit = 10,
): ReadonlyArray<NixPackageDoc> {
  return searchIndexDocuments(index, query, { limit });
}

export function findOptionDoc(
  documents: ReadonlyArray<NixOptionDoc>,
  name: string,
): NixOptionDoc | null {
  const normalizedName = normalizeSearchQuery(name);
  return (
    documents.find((document) => normalizeSearchQuery(document.name) === normalizedName) ?? null
  );
}

export function parseNixDiagnostics(
  stderr: string,
  workspaceRoot?: string,
): ReadonlyArray<NixDiagnostic> {
  const diagnostics: NixDiagnostic[] = [];
  const seen = new Set<string>();
  const normalizedWorkspaceRoot =
    typeof workspaceRoot === "string" && workspaceRoot.trim().length > 0
      ? workspaceRoot.replace(/[\\]+/g, "/")
      : null;

  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    const match =
      /^(?<file>[^:\s][^:]*):(?<line>\d+)(?::(?<column>\d+))?:\s*(?<severity>error|warning|info)?\s*:?\s*(?<message>.+)$/i.exec(
        line,
      ) ?? /^(?<severity>error|warning|info):\s*(?<message>.+)$/i.exec(line);
    if (!match?.groups) {
      continue;
    }

    const severity = (match.groups.severity?.toLowerCase() ??
      (line.toLowerCase().includes("warning") ? "warning" : "error")) as NixDiagnostic["severity"];
    const filePath = trimToNull(match.groups.file);
    if (filePath && normalizedWorkspaceRoot) {
      const normalizedFilePath = filePath.replace(/[\\]+/g, "/");
      if (!normalizedFilePath.startsWith(normalizedWorkspaceRoot)) {
        continue;
      }
    }
    const message = trimToNull(match.groups.message);
    if (!message) {
      continue;
    }
    const key = `${severity}:${filePath ?? ""}:${match.groups.line ?? ""}:${match.groups.column ?? ""}:${message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    diagnostics.push({
      severity,
      message,
      ...(filePath ? { filePath } : {}),
      ...(match.groups.line ? { line: Number(match.groups.line) } : {}),
      ...(match.groups.column ? { column: Number(match.groups.column) } : {}),
    });
  }

  return diagnostics;
}

export function defaultIndexManifest(input: {
  readonly revision: string;
  readonly channel: string | null;
  readonly builtAt: string;
}): NixDesignerIndexManifest {
  return {
    schemaVersion: NIX_DESIGNER_INDEX_SCHEMA_VERSION,
    revision: input.revision,
    channel: input.channel,
    builtAt: input.builtAt,
    optionCount: 0,
    packageCount: 0,
    lastError: null,
    staleReason: null,
  };
}

export function scopeToLabel(scope: NixDesignerScope | null | undefined): string {
  if (!scope || scope.kind === "project") {
    return "project";
  }
  return `host:${scope.hostName}`;
}
