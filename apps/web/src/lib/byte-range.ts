/** Inclusive on both ends, like the HTTP header. */
export interface ByteRange {
  end: number;
  start: number;
}

const SINGLE_RANGE = /^bytes=(?<first>\d*)-(?<last>\d*)$/u;

/**
 * Parses a single `bytes=` range against a file of `size` bytes. Null means
 * serve the whole file: no header, a malformed one, or several ranges, which
 * RFC 9110 lets a server ignore.
 */
export function parseRange(
  header: string | null,
  size: number
): ByteRange | "unsatisfiable" | null {
  const groups = SINGLE_RANGE.exec(header ?? "")?.groups;
  if (!groups) {
    return null;
  }
  const { first = "", last = "" } = groups;
  if (first === "" && last === "") {
    return null;
  }
  const lastByte = size - 1;
  const range =
    first === ""
      ? { start: Math.max(0, size - Number(last)), end: lastByte }
      : {
          start: Number(first),
          end: last === "" ? lastByte : Math.min(Number(last), lastByte),
        };
  if (range.start > range.end || range.start >= size) {
    return "unsatisfiable";
  }
  return range;
}
