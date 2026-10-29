import type { PoolClient } from 'pg';

type Connection = Pick<PoolClient, 'query'>;
export type TranslationPolicy = { validateTranslationSemantics: boolean; version: number };

/** Missing singleton defaults OFF; schema/query errors must still surface. */
export async function readTranslationPolicy(connection: Connection): Promise<TranslationPolicy> {
  const { rows } = await connection.query<{ validate_translation_semantics: boolean; version: number }>(
    'SELECT validate_translation_semantics,version FROM translation_settings WHERE id=1');
  return { validateTranslationSemantics: rows[0]?.validate_translation_semantics ?? false,
    version: rows[0]?.version ?? 0 };
}

/** Admin must supply its authenticated owner identity. The caller must use a dedicated connection; optimistic versioning prevents lost edits. */
export async function updateTranslationPolicy(connection: Connection, input: {
  role: string; actorId: string; expectedVersion: number; validateTranslationSemantics: boolean;
}): Promise<TranslationPolicy> {
  if (input.role !== 'owner' || !input.actorId) throw new Error('owner_required');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 ||
      typeof input.validateTranslationSemantics !== 'boolean') throw new Error('invalid_translation_policy');
  await connection.query('BEGIN');
  try {
    const { rows } = await connection.query<{ version: number }>(`UPDATE translation_settings
      SET validate_translation_semantics=$1,version=version+1,updated_at=now()
      WHERE id=1 AND version=$2 RETURNING version`, [input.validateTranslationSemantics, input.expectedVersion]);
    if (!rows.length) throw new Error('settings_version_conflict');
    await connection.query(`INSERT INTO translation_policy_audit(actor_id,version,validate_translation_semantics)
      VALUES($1,$2,$3)`, [input.actorId, rows[0].version, input.validateTranslationSemantics]);
    await connection.query('COMMIT');
    return { validateTranslationSemantics: input.validateTranslationSemantics, version: rows[0].version };
  } catch (error) { await connection.query('ROLLBACK'); throw error; }
}
