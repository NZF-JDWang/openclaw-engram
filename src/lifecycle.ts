import { statSync } from "node:fs";

const TRUNCATED_MARKER = "\n[truncated]";
const REMOVED_IMAGE_MARKER = "[image data removed]";
const REMOVED_METADATA_MARKER = "[metadata removed]";

export type SummaryDepthDistribution = {
  depth0: number;
  depth1: number;
  depth2: number;
  depth3Plus: number;
};

export function sanitizeStoredContent(value: string, maxBytes: number): string {
  return truncateUtf8Bytes(stripNoisyContent(value), maxBytes, TRUNCATED_MARKER);
}

export function sanitizeSummaryContent(value: string): string {
  return collapseBlankLines(stripNoisyContent(value));
}

export function computeSummaryQualityScore(summary: string, minUsefulChars: number): number {
  const trimmed = summary.trim();
  if (!trimmed) {
    return 0;
  }

  let score = 80;
  if (containsRemovedImageMarker(trimmed) || containsRawImageData(trimmed)) {
    score -= 60;
  }
  if (looksLikeRawTimestampedDump(trimmed)) {
    score -= 35;
  }
  if (trimmed.includes("Conversation info (untrusted metadata):") || trimmed.includes("<preconscious-memory")) {
    score -= 25;
  }
  if (trimmed.length < Math.max(10, Math.floor(minUsefulChars / 3))) {
    score -= 15;
  } else if (trimmed.length >= minUsefulChars) {
    score += 10;
  }
  return clamp(score, 0, 100);
}

export function isSummaryEligibleForCompaction(summary: string, minUsefulChars: number): boolean {
  const trimmed = summary.trim();
  return (
    trimmed.length >= 10
    && !containsRemovedImageMarker(trimmed)
    && !containsRawImageData(trimmed)
    && !looksLikeRawTimestampedDump(trimmed)
    && !trimmed.includes("Conversation info (untrusted metadata):")
    && !trimmed.includes("<preconscious-memory")
  );
}

export function looksLikeRawTimestampedDump(value: string): boolean {
  const lines = value.split(/\n+/).filter(Boolean);
  if (lines.length === 0) {
    return false;
  }
  const timestampedLines = lines.filter((line) => /^\[\d{4}-\d{2}-\d{2}[^\]]*\]/.test(line.trim())).length;
  return timestampedLines > 0 && timestampedLines / lines.length >= 0.5;
}

export function deriveSummaryDepthDistribution(rows: Array<{ depth?: number | null }>): SummaryDepthDistribution {
  const distribution: SummaryDepthDistribution = {
    depth0: 0,
    depth1: 0,
    depth2: 0,
    depth3Plus: 0,
  };
  for (const row of rows) {
    const depth = row.depth ?? 0;
    if (depth <= 0) {
      distribution.depth0 += 1;
    } else if (depth === 1) {
      distribution.depth1 += 1;
    } else if (depth === 2) {
      distribution.depth2 += 1;
    } else {
      distribution.depth3Plus += 1;
    }
  }
  return distribution;
}

export function readDbSizeBytes(dbPath: string): number {
  const candidates = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  return candidates.reduce((total, path) => {
    try {
      return total + statSync(path).size;
    } catch {
      return total;
    }
  }, 0);
}

export function stripNoisyContent(value: string): string {
  return collapseBlankLines(
    value
      .replace(/<preconscious-memory[\s\S]*?<\/preconscious-memory>/gi, REMOVED_METADATA_MARKER)
      .replace(
        /Conversation info \(untrusted metadata\):\s*\{[\s\S]*?\}(?=(?:\r?\n){2,}|$)/gi,
        REMOVED_METADATA_MARKER,
      )
      .replace(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\s]+/g, REMOVED_IMAGE_MARKER)
      .replace(/\b(?:iVBORw0KGgo|\/9j\/4AAQSkZJRgA|R0lGODlh)[A-Za-z0-9+/=\s]{256,}\b/g, REMOVED_IMAGE_MARKER)
      .replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/gm, ""),
  );
}

function truncateUtf8Bytes(value: string, maxBytes: number, marker: string): string {
  if (maxBytes <= 0 || Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  const markerBytes = Buffer.byteLength(marker, "utf8");
  const budget = Math.max(0, maxBytes - markerBytes);
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > budget) {
    end -= 1;
  }
  return `${value.slice(0, end).trimEnd()}${marker}`;
}

function containsRawImageData(value: string): boolean {
  return /\b(?:iVBORw0KGgo|\/9j\/4AAQSkZJRgA|R0lGODlh)[A-Za-z0-9+/=\s]{128,}\b/.test(value);
}

function containsRemovedImageMarker(value: string): boolean {
  return value.includes(REMOVED_IMAGE_MARKER);
}

function collapseBlankLines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
