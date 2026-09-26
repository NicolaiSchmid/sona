/**
 * Replaces every known secret in free text with a fixed marker. Longer secrets
 * are replaced first so an overlapping shorter secret (a username that is a
 * prefix of a password, say) cannot leave the tail of the longer one visible.
 */
export class PortalSecretRedactor {
  readonly #secrets = new Set<string>();
  #ordered: readonly string[] = [];

  addSecret(secret: string): void {
    if (secret.length === 0 || this.#secrets.has(secret)) {
      return;
    }
    this.#secrets.add(secret);
    this.#ordered = [...this.#secrets].sort((a, b) => b.length - a.length);
  }

  redactText(text: string): string {
    let redacted = text;
    for (const secret of this.#ordered) {
      redacted = redacted.split(secret).join("[REDACTED_SECRET]");
    }
    return redacted;
  }

  metadata(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      output[this.redactText(key)] = this.redactText(value);
    }
    return Object.freeze(output);
  }
}
