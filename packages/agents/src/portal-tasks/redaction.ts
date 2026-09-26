/**
 * Replaces every known secret in free text with a fixed marker in a single
 * pass. Longer secrets take precedence in the alternation so an overlapping
 * shorter secret (a username that is a prefix of a password, say) cannot leave
 * the tail of the longer one visible, and the marker itself is never rescanned.
 */
export class PortalSecretRedactor {
  static readonly MARKER = "[REDACTED_SECRET]";
  readonly #secrets = new Set<string>();
  #pattern: RegExp | undefined;

  addSecret(secret: string): void {
    if (secret.length === 0 || this.#secrets.has(secret)) {
      return;
    }
    this.#secrets.add(secret);
    const ordered = [...this.#secrets].sort((a, b) => b.length - a.length);
    this.#pattern = new RegExp(ordered.map(escapeRegExp).join("|"), "g");
  }

  redactText(text: string): string {
    return this.#pattern === undefined
      ? text
      : text.replace(this.#pattern, PortalSecretRedactor.MARKER);
  }

  metadata(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      output[this.redactText(key)] = this.redactText(value);
    }
    return Object.freeze(output);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
