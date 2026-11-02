import type { PoolClient } from 'pg';
import { nameHash } from './jobs.js';
import type { NameInput } from './openrouter.js';
import { parseCodexNames } from './codex.js';

export type CodexSnapshot = NameInput & { prior_name: string | null; prior_updated_at: string | null };
type Connection = Pick<PoolClient, 'query'>;
export const CODEX_NAME_MODEL = 'gpt-6.1-sol';

/** This preflight is deliberately read-only. Missing schema never triggers DDL. */
export async function assertCodexNameSchema(connection: Connection): Promise<void> {
  const required: Record<string, string[]> = {
    products: ['asin', 'name', 'brand'],
    product_translations: ['asin', 'locale', 'name', 'status', 'detail', 'detail_approved', 'name_only',
      'source_hash', 'model', 'name_source', 'name_issues', 'updated_at', 'translated_at',
      'name_revision', 'name_generation', 'name_model'],
    product_title_presentations: ['asin', 'source_name', 'translated_name', 'short_name', 'omitted_facts', 'model', 'updated_at'],
    codex_name_runs: ['id', 'trigger', 'jst_day', 'cycle_id', 'state', 'reason', 'selected', 'translated', 'failed', 'skipped', 'warnings', 'started_at', 'finished_at'],
    codex_name_cycles: ['id', 'started_at', 'finished_at'],
    codex_name_cycle_items: ['cycle_id', 'asin', 'attempts', 'last_attempt_at', 'completed_at'],
    codex_name_run_items: ['run_id', 'asin', 'source', 'prior_name', 'prior_updated_at', 'attempts', 'outcome', 'issues'],
    codex_name_history: ['id', 'run_id', 'asin', 'source', 'source_hash', 'previous', 'replacement', 'issues', 'model', 'generation', 'committed_at']
  };
  const { rows } = await connection.query<{ table_name: string; column_name: string }>(`
    SELECT table_name,column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1::text[])`, [Object.keys(required)]);
  const found = new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
  if (Object.entries(required).some(([table, columns]) => columns.some(column => !found.has(`${table}.${column}`)))) {
    throw new Error('codex_schema_unavailable');
  }
  const expectedIndexes: Record<string, RegExp> = {
    codex_name_one_active_cycle: /UNIQUE INDEX .* ON (?:public\.)?codex_name_cycles .*finished_at IS NULL/i,
    codex_name_one_scheduled_day: /UNIQUE INDEX .* ON (?:public\.)?codex_name_runs .*\(jst_day\).*trigger = 'scheduled'/i,
    codex_name_cycle_pending: /INDEX .* ON (?:public\.)?codex_name_cycle_items .*completed_at IS NULL.*attempts < 3/i,
    codex_name_history_asin: /INDEX .* ON (?:public\.)?codex_name_history .*asin, id DESC/i
  };
  const indexes = await connection.query<{ indexname: string; indexdef: string }>(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname=ANY($1::text[])`,
  [Object.keys(expectedIndexes)]);
  if (indexes.rows.length !== 4 || indexes.rows.some(row =>
    !expectedIndexes[row.indexname]?.test(row.indexdef))) throw new Error('codex_schema_unavailable');
  const triggers = await connection.query(`SELECT tgname FROM pg_trigger
    WHERE tgrelid='public.product_translations'::regclass AND tgname='mita_name_revision_guard'
      AND NOT tgisinternal AND tgenabled IN ('O','A')`);
  if (triggers.rows.length !== 1) throw new Error('codex_schema_unavailable');
}

/** Full title, short projection, revision and history share one transaction.
 * CAS protects both the current Amazon snapshot and any intervening title edit.
 * Warning publication is intentional for Codex and independent of the policy toggle. */
export async function saveCodexName(connection: Connection, input: {
  runId: string; cycleId: string; source: CodexSnapshot; full: string; short: string | null;
}): Promise<{ saved: boolean; issues: string[] }> {
  const { source, runId, cycleId } = input;
  // Revalidate at the persistence boundary; caller cannot manufacture warnings.
  const assessed = parseCodexNames([source], JSON.stringify({ translations: [
    { asin: source.asin, full: input.full, short: input.short }
  ] }));
  const full = assessed.names.get(source.asin);
  if (!full) throw new Error('invalid_codex_title');
  const short = assessed.shortNames.get(source.asin) ?? null;
  const issues = assessed.warnings.get(source.asin) ?? [];
  await connection.query('BEGIN');
  try {
    const current = await connection.query<NameInput>('SELECT asin,name,brand FROM products WHERE asin=$1 FOR UPDATE', [source.asin]);
    const previous = await connection.query<Record<string, unknown> & { name: string | null; revision_token: string }>(`
      SELECT name,status,model,name_model,name_revision,name_generation,name_source,name_issues,name_only,detail_approved,
        updated_at::text AS revision_token FROM product_translations WHERE asin=$1 AND locale='vi' FOR UPDATE`, [source.asin]);
    const old = previous.rows[0];
    if (!current.rows[0] || nameHash(current.rows[0]) !== nameHash(source) ||
        (old?.name ?? null) !== source.prior_name || (old?.revision_token ?? null) !== source.prior_updated_at) {
      await connection.query(`UPDATE codex_name_run_items SET outcome='source_changed',issues='["source_changed"]'
        WHERE run_id=$1 AND asin=$2 AND outcome='selected'`, [runId, source.asin]);
      await connection.query('COMMIT');
      return { saved: false, issues: ['source_changed'] };
    }
    // A run item must have a durable, committed reservation before publishing.
    const reserved = await connection.query(`SELECT asin FROM codex_name_run_items
      WHERE run_id=$1 AND asin=$2 AND outcome='selected' AND attempts>0
        AND source=$3::jsonb AND prior_name IS NOT DISTINCT FROM $4::text
        AND prior_updated_at IS NOT DISTINCT FROM $5::text FOR UPDATE`,
    [runId, source.asin, JSON.stringify({ asin: source.asin, name: source.name, brand: source.brand }), source.prior_name, source.prior_updated_at]);
    if (!reserved.rows.length) throw new Error('codex_reservation_missing');
    const oldShort = await connection.query('SELECT source_name,translated_name,short_name,omitted_facts,model FROM product_title_presentations WHERE asin=$1 FOR UPDATE', [source.asin]);
    const hash = nameHash(source);
    const history = await connection.query<{ id: string }>(`INSERT INTO codex_name_history
      (run_id,asin,source,source_hash,previous,replacement,issues,model,generation)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$1) RETURNING id`,
    [runId, source.asin, JSON.stringify({ name: source.name, brand: source.brand }), hash,
      JSON.stringify({ title: old ?? null, presentation: oldShort.rows[0] ?? null }),
      JSON.stringify({ full, short }), JSON.stringify(issues), CODEX_NAME_MODEL]);
    await connection.query(`INSERT INTO product_translations
      (asin,locale,name,source_hash,model,status,translated_at,name_only,name_source,name_issues,name_revision,name_generation,name_model)
      VALUES($1,'vi',$2,$3,$4,$5,now(),true,$6,$7,$8,$9,$4)
      ON CONFLICT(asin,locale) DO UPDATE SET name=EXCLUDED.name,status=EXCLUDED.status,
        name_only=CASE WHEN product_translations.detail IS NOT NULL AND
          (product_translations.detail_approved OR (product_translations.status IN ('success','warning') AND NOT product_translations.name_only))
          THEN false ELSE true END,
        detail_approved=product_translations.detail_approved OR
          (product_translations.status='success' AND NOT product_translations.name_only AND product_translations.detail IS NOT NULL),
        source_hash=CASE WHEN product_translations.detail IS NULL THEN EXCLUDED.source_hash ELSE product_translations.source_hash END,
        model=CASE WHEN product_translations.detail IS NULL THEN EXCLUDED.model ELSE product_translations.model END,
        name_source=EXCLUDED.name_source,name_issues=EXCLUDED.name_issues,
        name_revision=EXCLUDED.name_revision,name_generation=EXCLUDED.name_generation,name_model=EXCLUDED.name_model,
        translated_at=now(),updated_at=now()`,
    [source.asin, full, hash, CODEX_NAME_MODEL, issues.length ? 'warning' : 'success',
      JSON.stringify({ name: source.name, brand: source.brand }), JSON.stringify(issues), history.rows[0].id, runId]);
    // Always remove a previous short, even when it happens to match the new full.
    await connection.query('DELETE FROM product_title_presentations WHERE asin=$1', [source.asin]);
    if (short) await connection.query(`INSERT INTO product_title_presentations
      (asin,source_name,translated_name,short_name,omitted_facts,model)
      VALUES($1,$2,$3,$4,'[]',$5)`, [source.asin, source.name, full, short, CODEX_NAME_MODEL]);
    await connection.query(`UPDATE codex_name_run_items SET outcome='saved',issues=$3 WHERE run_id=$1 AND asin=$2`,
      [runId, source.asin, JSON.stringify(issues)]);
    await connection.query(`UPDATE codex_name_cycle_items SET completed_at=now() WHERE cycle_id=$1 AND asin=$2`, [cycleId, source.asin]);
    await connection.query('COMMIT');
    return { saved: true, issues };
  } catch (error) {
    // Never retry a failed or uncertain COMMIT. Let the run remain unresolved.
    try { await connection.query('ROLLBACK'); } catch { /* original failure wins */ }
    throw error;
  }
}

export async function codexNameProgress(connection: Connection) {
  const coverage = await connection.query<{ total: number; translated: number }>(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE t.name IS NOT NULL AND t.status IN ('success','warning'))::int AS translated
    FROM products p LEFT JOIN product_translations t ON t.asin=p.asin AND t.locale='vi'`);
  const rotation = await connection.query(`SELECT c.id AS cycle_id,count(i.asin)::int AS total,
    count(i.asin) FILTER (WHERE i.completed_at IS NOT NULL)::int AS completed,
    count(i.asin) FILTER (WHERE i.completed_at IS NULL AND i.attempts>=3)::int AS exhausted
    FROM codex_name_cycles c LEFT JOIN codex_name_cycle_items i ON i.cycle_id=c.id
    WHERE c.id=(SELECT max(id) FROM codex_name_cycles) GROUP BY c.id`);
  const lastRun = await connection.query(`SELECT id,trigger,state,reason,selected,translated,failed,skipped,warnings,
    started_at,finished_at FROM codex_name_runs ORDER BY started_at DESC LIMIT 1`);
  return { coverage: coverage.rows[0], rotation: rotation.rows[0] ?? null, lastRun: lastRun.rows[0] ?? null };
}
