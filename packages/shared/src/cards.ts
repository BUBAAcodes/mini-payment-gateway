// Card helpers. Full card numbers live only in the request that carries them: callers keep
// cardLast4() and cardNetwork(), never the number itself (rule 9).

export type CardNetwork = 'visa' | 'mastercard' | 'rupay' | 'amex' | 'unknown';

/** Digits only, 12 to 19 of them, and the last one is a correct Luhn check digit. */
export function isLuhnValid(cardNumber: string): boolean {
  if (!/^\d{12,19}$/.test(cardNumber)) return false;
  let sum = 0;
  for (let i = 0; i < cardNumber.length; i++) {
    // Walk from the right; double every second digit, and subtract 9 when that goes past 9.
    let digit = Number(cardNumber[cardNumber.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** The network from the number's first digits (its IIN range). */
export function cardNetwork(cardNumber: string): CardNetwork {
  if (/^3[47]/.test(cardNumber)) return 'amex';
  if (cardNumber.startsWith('4')) return 'visa';
  const first4 = Number(cardNumber.slice(0, 4));
  if (/^5[1-5]/.test(cardNumber) || (first4 >= 2221 && first4 <= 2720)) return 'mastercard';
  if (/^(60|65|81|82|508)/.test(cardNumber)) return 'rupay';
  return 'unknown';
}

export function cardLast4(cardNumber: string): string {
  return cardNumber.slice(-4);
}

/** A card is good through the last day of its expiry month (UTC). */
export function isCardExpired(expiryMonth: number, expiryYear: number, now = new Date()): boolean {
  const year = now.getUTCFullYear();
  return expiryYear < year || (expiryYear === year && expiryMonth < now.getUTCMonth() + 1);
}
