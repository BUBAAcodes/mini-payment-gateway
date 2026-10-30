// What the gateway needs from a bank. The fake bank implements it today; a real one could later.

export interface UpiAuthorization {
  method: 'upi';
  vpa: string;
}

/**
 * Sent after the customer enters the OTP. Only the last four digits travel: the full card number
 * never leaves the checkout request (rule 9).
 */
export interface CardAuthorization {
  method: 'card';
  cardLast4: string;
  otp: string;
}

export type AuthorizeRequest = {
  /** Our pay_ ID. The bank keys its record on it, so asking twice never books twice. */
  gatewayReference: string;
  amount: number;
} & (UpiAuthorization | CardAuthorization);

export interface RefundRequest {
  /**
   * Our rfnd_ ID. The bank keys its record on it, so asking twice never refunds twice: the
   * refund status checks rely on this to resend a refund the bank never received.
   */
  gatewayReference: string;
  /** The pay_ ID being refunded. */
  paymentReference: string;
  amount: number;
}

export interface BankAnswer {
  bankRef: string;
  /** "pending" means not decided yet, or not telling us: ask again with getStatus. */
  status: 'approved' | 'declined' | 'pending';
  declineReason: string | null;
}

export type StatusAnswer = BankAnswer | { status: 'not_found' };

export interface CallOptions {
  /**
   * Cuts the wait short. The call then rejects with an AbortError, but the bank may still have
   * the request and decide it later: treat it as unknown, never as failed (rule 10).
   */
  signal?: AbortSignal;
}

export interface BankClient {
  authorize(request: AuthorizeRequest, options?: CallOptions): Promise<BankAnswer>;
  /** Looks up by our reference, because after a timeout we never received the bank's. */
  getStatus(gatewayReference: string): Promise<StatusAnswer>;
  refund(request: RefundRequest, options?: CallOptions): Promise<BankAnswer>;
  /** The bank's CSV of everything it decided on one day (YYYY-MM-DD, India time). */
  settlementFile(bankDate: string): Promise<string>;
}
