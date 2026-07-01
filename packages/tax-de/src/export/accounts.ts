/**
 * Account path glob matching for tax section mapping. Mirrors the policy matcher
 * used elsewhere: `Foo:*` matches any descendant of `Foo:`, a trailing `*` is a
 * prefix match, otherwise the match is exact.
 */
export function matchesAccountPattern(account: string, pattern: string): boolean {
  if (pattern.endsWith(":*")) {
    return account.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith("*")) {
    return account.startsWith(pattern.slice(0, -1));
  }
  return account === pattern;
}
