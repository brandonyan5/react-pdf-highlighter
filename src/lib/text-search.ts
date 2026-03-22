/**
 * Fuzzy text search utilities for finding and highlighting text in PDF text layers.
 *
 * Uses semi-global alignment (modified Levenshtein) to find approximate substring
 * matches, handling OCR errors, whitespace differences, and minor reformatting.
 */

/**
 * Build a mapping from normalized string positions back to original positions.
 * Normalization: lowercase, collapse whitespace to single space, trim.
 */
function buildPositionMap(original: string): {
  normalized: string;
  map: number[];
} {
  let normalized = "";
  const map: number[] = [];
  let lastWasSpace = false;

  for (let i = 0; i < original.length; i++) {
    const char = original[i];
    if (/\s/.test(char)) {
      if (!lastWasSpace && normalized.length > 0) {
        normalized += " ";
        map.push(i);
        lastWasSpace = true;
      }
    } else {
      normalized += char.toLowerCase();
      map.push(i);
      lastWasSpace = false;
    }
  }

  // Trim trailing space
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    map.pop();
  }

  return { normalized, map };
}

/**
 * Semi-global fuzzy substring match using modified Levenshtein distance.
 * The first row is initialized to 0 (free start in text), allowing the query
 * to align to any substring of text with minimum edit distance.
 *
 * Time: O(m*n), Space: O(n) with rolling arrays.
 */
function fuzzySubstringMatch(
  query: string,
  text: string,
  maxDistanceRatio: number
): { start: number; end: number; distance: number } | null {
  const m = query.length;
  const n = text.length;

  if (m === 0 || n === 0) return null;

  let prevRow = new Array(n + 1).fill(0); // Free start in text
  let currRow = new Array(n + 1).fill(0);
  let prevStart = Array.from({ length: n + 1 }, (_, j) => j);
  let currStart = new Array(n + 1).fill(0);

  for (let i = 1; i <= m; i++) {
    currRow[0] = i;
    currStart[0] = 0;

    for (let j = 1; j <= n; j++) {
      if (query[i - 1] === text[j - 1]) {
        currRow[j] = prevRow[j - 1];
        currStart[j] = prevStart[j - 1];
      } else {
        const sub = prevRow[j - 1];
        const del = prevRow[j];
        const ins = currRow[j - 1];
        const min = Math.min(sub, del, ins);
        currRow[j] = 1 + min;

        if (min === sub) currStart[j] = prevStart[j - 1];
        else if (min === del) currStart[j] = prevStart[j];
        else currStart[j] = currStart[j - 1];
      }
    }

    [prevRow, currRow] = [currRow, prevRow];
    [prevStart, currStart] = [currStart, prevStart];
  }

  // Find best end position (minimum edit distance in last row)
  let bestEnd = 0;
  let bestDist = prevRow[0];
  for (let j = 1; j <= n; j++) {
    if (prevRow[j] < bestDist) {
      bestDist = prevRow[j];
      bestEnd = j;
    }
  }

  if (bestDist > m * maxDistanceRatio) {
    return null;
  }

  return { start: prevStart[bestEnd], end: bestEnd, distance: bestDist };
}

/**
 * Find the best fuzzy match of `searchText` within `pageText`.
 *
 * @param searchText - The text to search for
 * @param pageText - The full text content of the page
 * @param threshold - Minimum similarity score (0-1), default 0.7
 * @returns Match positions in the original pageText, or null
 */
export function findTextMatch(
  searchText: string,
  pageText: string,
  threshold: number = 0.7
): { start: number; end: number; score: number } | null {
  if (!searchText || !pageText) return null;

  const searchMap = buildPositionMap(searchText);
  const pageMap = buildPositionMap(pageText);

  if (!searchMap.normalized || !pageMap.normalized) return null;

  // Fast path: exact normalized substring match
  const exactIdx = pageMap.normalized.indexOf(searchMap.normalized);
  if (exactIdx !== -1) {
    const origStart = pageMap.map[exactIdx];
    const lastIdx = Math.min(
      exactIdx + searchMap.normalized.length - 1,
      pageMap.map.length - 1
    );
    const origEnd = pageMap.map[lastIdx] + 1;
    return { start: origStart, end: origEnd, score: 1.0 };
  }

  // Fuzzy match on normalized text
  const match = fuzzySubstringMatch(
    searchMap.normalized,
    pageMap.normalized,
    1 - threshold
  );

  if (!match) return null;

  // Map normalized positions back to original text positions
  const origStart = pageMap.map[match.start] ?? 0;
  const lastIdx = Math.min(match.end - 1, pageMap.map.length - 1);
  const origEnd = (pageMap.map[lastIdx] ?? pageText.length - 1) + 1;
  const score = 1 - match.distance / searchMap.normalized.length;

  return { start: origStart, end: origEnd, score };
}

/**
 * Extract full text from a text layer div by concatenating all span contents.
 */
export function extractTextFromLayer(textLayerDiv: HTMLElement): string {
  const spans = Array.from(textLayerDiv.querySelectorAll("span"));
  return spans.map((span) => span.textContent || "").join("");
}

/**
 * Create a DOM Range covering the text between matchStart and matchEnd
 * within the text layer's span elements.
 */
export function createRangeFromMatch(
  textLayerDiv: HTMLElement,
  matchStart: number,
  matchEnd: number
): Range | null {
  const spans = Array.from(textLayerDiv.querySelectorAll("span"));

  let currentOffset = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;

  for (const span of spans) {
    const textNode = span.firstChild;
    if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

    const text = textNode.textContent || "";
    const spanStart = currentOffset;
    const spanEnd = currentOffset + text.length;

    if (!startNode && matchStart >= spanStart && matchStart < spanEnd) {
      startNode = textNode;
      startOffset = matchStart - spanStart;
    }

    if (!endNode && matchEnd > spanStart && matchEnd <= spanEnd) {
      endNode = textNode;
      endOffset = matchEnd - spanStart;
    }

    currentOffset = spanEnd;
    if (startNode && endNode) break;
  }

  // Handle match extending to end of text
  if (startNode && !endNode && currentOffset >= matchEnd) {
    const lastSpan = spans[spans.length - 1];
    const lastTextNode = lastSpan?.firstChild;
    if (lastTextNode) {
      endNode = lastTextNode;
      endOffset = (lastTextNode.textContent || "").length;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(
      startNode,
      Math.min(startOffset, (startNode.textContent || "").length)
    );
    range.setEnd(
      endNode,
      Math.min(endOffset, (endNode.textContent || "").length)
    );
    return range;
  } catch {
    return null;
  }
}
