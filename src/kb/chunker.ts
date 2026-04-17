export type BreakPoint = {
  pos: number;
  score: number;
};

export type CodeFenceRegion = {
  start: number;
  end: number;
};

const CHUNK_SIZE_CHARS = 900 * 4;
const CHUNK_OVERLAP_CHARS = Math.floor(CHUNK_SIZE_CHARS * 0.15);
const CHUNK_WINDOW_CHARS = 200 * 4;

const BREAK_PATTERNS: Array<[RegExp, number]> = [
  [/\n#{1}(?!#)/g, 100],
  [/\n#{2}(?!#)/g, 90],
  [/\n#{3}(?!#)/g, 80],
  [/\n```/g, 80],
  [/\n(?:---|\*\*\*|___)\s*\n/g, 60],
  [/\n\n+/g, 20],
  [/\n[-*]\s/g, 5],
  [/\n\d+\.\s/g, 5],
  [/\n/g, 1],
];

export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
): Array<{ text: string; pos: number }> {
  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);
  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}

export function scanBreakPoints(text: string): BreakPoint[] {
  const seen = new Map<number, BreakPoint>();
  for (const [pattern, score] of BREAK_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const pos = match.index ?? 0;
      const current = seen.get(pos);
      if (!current || score > current.score) {
        seen.set(pos, { pos, score });
      }
    }
  }
  return Array.from(seen.values()).sort((left, right) => left.pos - right.pos);
}

export function findCodeFences(text: string): CodeFenceRegion[] {
  const regions: CodeFenceRegion[] = [];
  const pattern = /\n```/g;
  let start = -1;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (start === -1) {
      start = index;
    } else {
      regions.push({ start, end: index + match[0].length });
      start = -1;
    }
  }
  if (start !== -1) {
    regions.push({ start, end: text.length });
  }
  return regions;
}

export function chunkDocumentWithBreakPoints(
  content: string,
  breakPoints: BreakPoint[],
  codeFences: CodeFenceRegion[],
  maxChars: number,
  overlapChars: number,
  windowChars: number,
): Array<{ text: string; pos: number }> {
  if (content.length <= maxChars) {
    return [{ text: content, pos: 0 }];
  }

  const chunks: Array<{ text: string; pos: number }> = [];
  let charPos = 0;

  while (charPos < content.length) {
    const targetEndPos = Math.min(charPos + maxChars, content.length);
    let endPos = targetEndPos;

    if (endPos < content.length) {
      const cutoff = findBestCutoff(breakPoints, targetEndPos, windowChars, codeFences);
      if (cutoff > charPos && cutoff <= targetEndPos) {
        endPos = cutoff;
      }
    }

    if (endPos <= charPos) {
      endPos = Math.min(charPos + maxChars, content.length);
    }

    chunks.push({ text: content.slice(charPos, endPos), pos: charPos });

    if (endPos >= content.length) {
      break;
    }
    charPos = endPos - overlapChars;
    if (charPos <= chunks[chunks.length - 1]!.pos) {
      charPos = endPos;
    }
  }

  return chunks;
}

function findBestCutoff(
  breakPoints: BreakPoint[],
  targetCharPos: number,
  windowChars: number,
  codeFences: CodeFenceRegion[],
): number {
  const windowStart = targetCharPos - windowChars;
  let bestScore = -1;
  let bestPos = targetCharPos;

  for (const point of breakPoints) {
    if (point.pos < windowStart) {
      continue;
    }
    if (point.pos > targetCharPos) {
      break;
    }
    if (isInsideCodeFence(point.pos, codeFences)) {
      continue;
    }

    const distance = targetCharPos - point.pos;
    const normalized = distance / windowChars;
    const multiplier = 1 - normalized * normalized * 0.7;
    const score = point.score * multiplier;
    if (score > bestScore) {
      bestScore = score;
      bestPos = point.pos;
    }
  }

  return bestPos;
}

function isInsideCodeFence(pos: number, fences: CodeFenceRegion[]): boolean {
  return fences.some((fence) => pos > fence.start && pos < fence.end);
}