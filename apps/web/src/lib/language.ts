const NAMES = new Intl.DisplayNames(["en"], { type: "language" });

export function languageName(code: string): string {
  return NAMES.of(code) ?? code;
}
