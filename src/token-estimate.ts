const CJK_REGEX = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;
const WORD_REGEX = /[A-Za-z0-9_]/;

export function estimateTokens(text: string): number {
  if (!text) {
    return 0;
  }

  let wordChars = 0;
  let cjkChars = 0;
  let symbolChars = 0;
  let lineBreaks = 0;

  for (const char of text) {
    if (char === "\n") {
      lineBreaks += 1;
      continue;
    }
    if (/\s/u.test(char)) {
      continue;
    }
    if (CJK_REGEX.test(char)) {
      cjkChars += 1;
      continue;
    }
    if (WORD_REGEX.test(char)) {
      wordChars += 1;
      continue;
    }
    symbolChars += 1;
  }

  return Math.ceil(wordChars / 4 + cjkChars + symbolChars / 2 + lineBreaks);
}