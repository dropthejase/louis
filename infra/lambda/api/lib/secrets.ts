/**
 * Secret-loading stub for the backend Lambda.
 *
 * The RDS Data API reads DB_SECRET_ARN internally — the Lambda never needs
 * to decrypt the database password itself. This function exists as a hook
 * for any future secrets that do need explicit loading (e.g. third-party API
 * keys) and is called from the Lambda handler on every cold start.
 */
export async function loadSecrets(): Promise<void> {
  // No-op: RDS Data API reads DB_SECRET_ARN internally.
}
