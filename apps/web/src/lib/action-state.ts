// What a dashboard Server Action hands back to its form (through useActionState). Plain types, so
// Client Components can import this file.

export interface ActionState {
  status: 'idle' | 'error' | 'done';
  message?: string;
  /** The form field the error is about, if any. */
  field?: string;
}

/** For actions that send an Idempotency-Key: the key the form must send on its next submit. */
export interface KeyedState extends ActionState {
  idempotencyKey: string;
}

/** For actions whose answer holds a secret shown this once (API key, webhook signing secret). */
export interface SecretState extends ActionState {
  secret?: string;
}

export const IDLE: ActionState = { status: 'idle' };
