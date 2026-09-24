/**
 * Every rejection an admission or a query can produce. These are distinct
 * types on purpose: "the projection does not cover this instant" is not an
 * error condition of the same kind as "this entry is malformed", and an API
 * layer maps them to different status codes.
 */
export type ProjectionErrorCode =
  | 'MALFORMED_ENTRY'
  | 'NON_CONSECUTIVE_VERSION'
  | 'EFFECTIVE_AT_NOT_INCREASING'
  | 'BROKEN_COMMITMENT_LINKAGE'
  | 'COMMITMENT_REUSED'
  | 'PROOF_PROFILE_REJECTED'
  | 'GAP_ALREADY_OPEN'
  | 'NO_OPEN_GAP'
  | 'NOT_SETTLEMENT_AUTHORITY'
  | 'SETTLEMENT_EXISTS'
  | 'SETTLEMENT_EXPIRED'
  | 'DEADLINE_OUT_OF_RANGE'
  | 'HOLDER_MISMATCH'
  | 'UNKNOWN_TOKEN'
  | 'EMPTY_PROJECTION'
  | 'UNKNOWN_VERSION'
  | 'INSTANT_NOT_COVERED';

export class ProjectionError extends Error {
  readonly code: ProjectionErrorCode;

  constructor(code: ProjectionErrorCode, message: string) {
    super(message);
    this.name = 'ProjectionError';
    this.code = code;
  }
}

export const reject = (code: ProjectionErrorCode, message: string): never => {
  throw new ProjectionError(code, message);
};
