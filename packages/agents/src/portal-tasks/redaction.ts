import type { CapturedPortalConsoleMessage } from "./provenance.js";

export class PortalSecretRedactor {
  readonly #secrets = new Set<string>();

  addSecret(secret: string): void {
    if (secret.length > 0) {
      this.#secrets.add(secret);
    }
  }

  redactText(text: string): string {
    let redacted = text;
    for (const secret of this.#secrets) {
      redacted = redacted.split(secret).join("[REDACTED_SECRET]");
    }
    return redacted;
  }

  redactConsoleMessage(message: CapturedPortalConsoleMessage): CapturedPortalConsoleMessage {
    return {
      type: this.redactText(message.type),
      text: this.redactText(message.text),
    };
  }

  metadata(input: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
    const output: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      output[this.redactText(key)] = this.redactText(value);
    }
    return Object.freeze(output);
  }
}
