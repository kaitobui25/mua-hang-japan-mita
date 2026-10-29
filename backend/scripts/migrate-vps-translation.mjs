import pg from 'pg';

// Explicit translation-only VPS migration. Catalog sync must never run DDL.
const mode = process.argv[2];
if (!['--dry-run', '--apply'].includes(mode) || process.argv.length !== 3) {
  throw Error('Usage: node scripts/migrate-vps-translation.mjs --dry-run|--apply');
}

const url = process.env.MITA_VPS_DATABASE_URL;
if (!url) throw Error('Missing encrypted VPS database connection');
const endpoint = new URL(url);
if (!['postgres:', 'postgresql:'].includes(endpoint.protocol) ||
    endpoint.hostname !== '127.0.0.1' || endpoint.port !== '15432' ||
    endpoint.pathname !== '/mita' || endpoint.search || endpoint.hash) {
  throw Error('Translation migration requires the approved SSH-forwarded Mita database');
}

const requiredTables = ['products', 'product_translations',
  'local_detail_translations', 'local_detail_translation_items'];
const requiredColumns = {
  product_translations: {
    name_only: 'bool', detail_attempted_at: 'timestamptz', name_attempts: 'int4',
    name_source: 'jsonb', name_issues: 'jsonb', detail_approved: 'bool'
  },
  local_detail_translations: { english_slots_backfilled_at: 'timestamptz' },
  local_detail_translation_items: { warning: 'bool', issues: 'jsonb' },
  translation_settings: {
    id: 'int4', version: 'int4', validate_translation_semantics: 'bool', updated_at: 'timestamptz'
  },
  translation_policy_audit: {
    id: 'int8', actor_id: 'text', version: 'int4',
    validate_translation_semantics: 'bool', created_at: 'timestamptz'
  },
  translation_name_repairs: {
    asin: 'varchar', before_value: 'jsonb', after_value: 'jsonb', created_at: 'timestamptz'
  }
};
const newTables = ['translation_settings', 'translation_policy_audit', 'translation_name_repairs'];
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 12000 });

async function inspect() {
  const names = [...requiredTables, ...newTables];
  // A single PG client must not execute queries concurrently; keep inspection
  // deterministic both before and inside the migration transaction.
  const { rows: tables } = await client.query(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[])", [names]);
  const { rows: columns } = await client.query(
    "SELECT table_name,column_name,udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[])", [Object.keys(requiredColumns)]);
  const { rows: constraints } = await client.query(`SELECT conname,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid=to_regclass('public.product_translations') AND contype='c'`);
  const { rows: settings } = await client.query("SELECT to_regclass('public.translation_settings')::text AS settings");
  const existingTables = new Set(tables.map(row => row.tablename));
  const existingColumns = new Map(columns.map(row => [`${row.table_name}.${row.column_name}`, row.udt_name]));
  const statusChecks = constraints.filter(row => /\bstatus\b/i.test(row.definition));
  return {
    missingBaseTables: requiredTables.filter(table => !existingTables.has(table)),
    missingColumns: Object.entries(requiredColumns).flatMap(([table, fields]) =>
      Object.keys(fields).filter(field => !existingColumns.has(`${table}.${field}`))
        .map(field => `${table}.${field}`)),
    wrongTypes: Object.entries(requiredColumns).flatMap(([table, fields]) =>
      Object.entries(fields).filter(([field, type]) => existingColumns.has(`${table}.${field}`) &&
          existingColumns.get(`${table}.${field}`) !== type)
        .map(([field, type]) => `${table}.${field} expected ${type}`)),
    missingNewTables: newTables.filter(table => !existingTables.has(table)),
    statusChecks: statusChecks.map(({ conname, definition }) => ({ name: conname, definition })),
    settingsExists: Boolean(settings[0]?.settings)
  };
}

let transaction = false;
try {
  await client.connect();
  const { rows } = await client.query(`SELECT current_database() AS db,
    current_setting('server_version_num')::integer AS version`);
  if (rows[0].db !== 'mita' || rows[0].version < 160000) {
    throw Error('Unexpected VPS database identity or PostgreSQL version');
  }
  const before = await inspect();
  if (before.missingBaseTables.length) {
    throw Error('Missing base catalog tables: ' + before.missingBaseTables.join(', '));
  }
  if (before.wrongTypes.length && mode === '--apply') {
    throw Error('Unexpected existing translation column types: ' + before.wrongTypes.join(', '));
  }
  if (mode === '--dry-run') {
    console.log('TRANSLATION_DRY_RUN ' + JSON.stringify(before));
  } else {
    const incompleteTables = before.missingColumns.filter(column =>
      newTables.some(table => !before.missingNewTables.includes(table) && column.startsWith(table + '.')));
    if (incompleteTables.length) throw Error('Existing translation tables have missing columns: ' + incompleteTables.join(', '));
    // Do not silently remove any nonstandard status constraint.
    if (before.statusChecks.some(check => check.name !== 'product_translations_status_check')) {
      throw Error('Unexpected status constraints; inspect schema before migration');
    }
    await client.query('BEGIN');
    transaction = true;
    await client.query("SET LOCAL lock_timeout = '3s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(70400200)');

    await client.query(`ALTER TABLE public.product_translations
      ADD COLUMN IF NOT EXISTS name_only boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS detail_attempted_at timestamptz,
      ADD COLUMN IF NOT EXISTS name_attempts integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS name_source jsonb,
      ADD COLUMN IF NOT EXISTS name_issues jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS detail_approved boolean NOT NULL DEFAULT false`);
    await client.query(`ALTER TABLE public.local_detail_translation_items
      ADD COLUMN IF NOT EXISTS warning boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS issues jsonb NOT NULL DEFAULT '[]'::jsonb`);
    await client.query(`ALTER TABLE public.local_detail_translations
      ADD COLUMN IF NOT EXISTS english_slots_backfilled_at timestamptz`);

    if (!before.statusChecks.some(check =>
      check.name === 'product_translations_status_check' && check.definition.includes("'warning'"))) {
      await client.query('ALTER TABLE public.product_translations DROP CONSTRAINT IF EXISTS product_translations_status_check');
      await client.query(`ALTER TABLE public.product_translations
        ADD CONSTRAINT product_translations_status_check
        CHECK (status IN ('pending','success','failed','warning'))`);
    }

    await client.query(`CREATE TABLE IF NOT EXISTS public.translation_settings (
      id integer PRIMARY KEY CHECK (id = 1),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      validate_translation_semantics boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('INSERT INTO public.translation_settings(id) VALUES (1) ON CONFLICT (id) DO NOTHING');
    await client.query(`CREATE TABLE IF NOT EXISTS public.translation_policy_audit (
      id bigserial PRIMARY KEY,
      actor_id text NOT NULL,
      version integer NOT NULL,
      validate_translation_semantics boolean NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS public.translation_name_repairs (
      asin varchar(10) PRIMARY KEY REFERENCES public.products(asin),
      before_value jsonb NOT NULL,
      after_value jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    const after = await inspect();
    const validStatus = after.statusChecks.some(check =>
      check.name === 'product_translations_status_check' && check.definition.includes("'warning'"));
    if (after.missingBaseTables.length || after.missingColumns.length || after.wrongTypes.length ||
        after.missingNewTables.length || !validStatus) {
      throw Error('Post-migration schema verification failed');
    }
    await client.query('COMMIT');
    transaction = false;
    console.log('TRANSLATION_MIGRATION_OK ' + JSON.stringify(after));
  }
} catch (error) {
  if (transaction) await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end();
}
