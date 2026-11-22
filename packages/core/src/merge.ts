import type { Entry } from "./contract.js";

export interface ParsedContribution {
  entry: Entry;
  subject: string;
  kind: string;
  contributorId: string;
  timestamp: string;
}

const CONTRIBUTION_PATTERN =
  /^(?<subject>[^.]+)\.(?<kind>[^.]+)\.(?<contributorId>[^.]+)\.(?<timestamp>\d{4}-\d{2}-\d{2}T\d{6}Z)\.(?<ext>[^.]+)$/;

export function parseContribution(entry: Entry): ParsedContribution | null {
  const name = entry.path.split("/").pop() ?? entry.path;
  const match = CONTRIBUTION_PATTERN.exec(name);
  if (!match?.groups) return null;
  const { subject, kind, contributorId, timestamp } = match.groups;
  return { entry, subject, kind, contributorId, timestamp };
}

/** Spec section 7: group by subject, order by timestamp then contributor ID. */
export function groupBySubject(entries: Entry[]): Map<string, ParsedContribution[]> {
  const groups = new Map<string, ParsedContribution[]>();
  for (const entry of entries) {
    const parsed = parseContribution(entry);
    if (!parsed) continue;
    const list = groups.get(parsed.subject) ?? [];
    list.push(parsed);
    groups.set(parsed.subject, list);
  }
  for (const list of groups.values()) {
    list.sort(
      (a, b) => a.timestamp.localeCompare(b.timestamp) || a.contributorId.localeCompare(b.contributorId),
    );
  }
  return groups;
}

/** Spec section 7: the newest-named derived/ snapshot wins; concurrent rebuilds are redundant, not conflicting. */
export function latestDerivedSnapshot(entries: Entry[]): Entry | null {
  if (entries.length === 0) return null;
  return [...entries].sort((a, b) => b.path.localeCompare(a.path))[0];
}
