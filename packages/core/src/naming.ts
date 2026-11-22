// Contribution filenames follow spec section 4:
//   <subject>.<kind>.<contributorId>.<UTC timestamp>.<ext>
// e.g. IMG_0412.story.amy.2026-11-16T105200Z.json

export interface ContributionName {
  subject: string;
  kind: string;
  contributorId: string;
  ext: string;
  /** Defaults to now. */
  timestamp?: Date;
}

export function formatTimestamp(date: Date): string {
  const iso = date.toISOString(); // 2026-11-16T10:52:00.000Z
  const [datePart, timePart] = iso.split("T");
  const hhmmss = timePart.slice(0, 8).replace(/:/g, "");
  return `${datePart}T${hhmmss}Z`;
}

export function buildContributionPath(n: ContributionName): string {
  const timestamp = formatTimestamp(n.timestamp ?? new Date());
  return `${n.subject}.${n.kind}.${n.contributorId}.${timestamp}.${n.ext}`;
}

/** Inserts a disambiguating suffix before the extension, for collision retries. */
export function disambiguate(path: string, suffix: string): string {
  const lastDot = path.lastIndexOf(".");
  if (lastDot === -1) return `${path}.${suffix}`;
  return `${path.slice(0, lastDot)}.${suffix}${path.slice(lastDot)}`;
}
