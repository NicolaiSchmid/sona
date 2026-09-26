/**
 * Exact decimal helpers.
 *
 * Money in Sona is never represented as a JavaScript `number`. Amounts are
 * decimal strings (e.g. "-84.23") and arithmetic is performed with `BigInt`
 * at a common scale so that ledger balancing is exact and auditable.
 */

/** A decimal string such as "0", "-84.23", or "1000.00". */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Returns true if `value` is a syntactically valid decimal string. */
export function isValidDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value);
}

interface ScaledDecimal {
  /** Signed integer value at `scale` decimal places. */
  readonly value: bigint;
  /** Number of fractional digits. */
  readonly scale: number;
}

function parseScaled(value: string): ScaledDecimal {
  if (!isValidDecimalString(value)) {
    throw new InvalidDecimalError(value);
  }
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [intPart = "0", fracPart = ""] = unsigned.split(".");
  const digits = `${intPart}${fracPart}`;
  const magnitude = BigInt(digits === "" ? "0" : digits);
  return { value: negative ? -magnitude : magnitude, scale: fracPart.length };
}

function rescale(input: ScaledDecimal, targetScale: number): bigint {
  if (targetScale < input.scale) {
    throw new Error("rescale only supports widening the scale");
  }
  const factor = 10n ** BigInt(targetScale - input.scale);
  return input.value * factor;
}

/** Thrown when a value cannot be parsed as a decimal string. */
export class InvalidDecimalError extends Error {
  readonly value: string;
  constructor(value: string) {
    super(`Invalid decimal string: ${JSON.stringify(value)}`);
    this.name = "InvalidDecimalError";
    this.value = value;
  }
}

/**
 * Sums a list of decimal strings exactly and returns the canonical decimal
 * string of the total. Throws {@link InvalidDecimalError} on bad input.
 */
export function sumDecimals(values: readonly string[]): string {
  if (values.length === 0) {
    return "0";
  }
  const parsed = values.map(parseScaled);
  const scale = parsed.reduce((max, p) => Math.max(max, p.scale), 0);
  const total = parsed.reduce((acc, p) => acc + rescale(p, scale), 0n);
  return formatScaled(total, scale);
}

/** Returns true if the decimal string equals zero (e.g. "0", "0.00", "-0"). */
export function isZeroDecimal(value: string): boolean {
  return parseScaled(value).value === 0n;
}

/**
 * Parses a decimal string into a signed integer at exactly `scale` fractional
 * digits. Throws {@link InvalidDecimalError} on bad input and a plain `Error`
 * if the value carries more fractional digits than `scale` can represent, so
 * callers never silently lose precision.
 */
export function toScaledBigInt(value: string, scale: number): bigint {
  const parsed = parseScaled(value);
  if (parsed.scale > scale) {
    throw new Error(`Decimal ${JSON.stringify(value)} has more than ${scale} fractional digit(s)`);
  }
  return rescale(parsed, scale);
}

/** Formats a signed integer at `scale` fractional digits as a canonical decimal string. */
export function fromScaledBigInt(value: bigint, scale: number): string {
  return formatScaled(value, scale);
}

/**
 * Divides `numerator` by `denominator` rounding half away from zero. Both
 * operands are plain integers; callers scale them first so the quotient lands
 * at the intended number of fractional digits.
 */
export function divideRoundHalfAwayFromZero(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division by zero");
  }
  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = (2n * absNumerator + absDenominator) / (2n * absDenominator);
  return negative ? -quotient : quotient;
}

function formatScaled(value: bigint, scale: number): string {
  if (scale === 0) {
    return value.toString();
  }
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale);
  const formatted = `${intPart}.${fracPart}`;
  return negative ? `-${formatted}` : formatted;
}
