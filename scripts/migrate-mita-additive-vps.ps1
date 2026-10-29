# Add only the schema objects required by the new Mita release.
# Avoid migrate.ts: it also updates catalog/queue history in production.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$sqlDir = Join-Path $root 'backend\src\db'
$schema = [IO.File]::ReadAllText((Join-Path $sqlDir 'schema.sql'), [Text.Encoding]::UTF8)
$marker = '-- Amazon snapshots live in the existing replicated product_details provenance.'
if ($schema.IndexOf($marker, [StringComparison]::Ordinal) -lt 0) {
    throw 'Expected metrics-view section not present; migration halted.'
}
$metricsView = $schema.Substring($schema.IndexOf($marker, [StringComparison]::Ordinal))
if ($metricsView -notmatch 'CREATE OR REPLACE VIEW amazon_product_metrics AS' -or
    $metricsView -notmatch 'm\.snapshot->>''publicationRights''') {
    throw 'Unexpected metrics view definition; migration halted.'
}
$files = @('order-notifications.sql','email-delivery.sql','title-presentations.sql')
$sql = @('BEGIN;',"SET LOCAL lock_timeout = '5s';", "SET LOCAL statement_timeout = '30s';",
         'SELECT pg_advisory_xact_lock(70400200);', 'SET ROLE mita_app;')
foreach ($file in $files) {
    $sql += [IO.File]::ReadAllText((Join-Path $sqlDir $file), [Text.Encoding]::UTF8)
}
$sql += $metricsView
$sql += @(
    "DO `$`$ BEGIN IF (SELECT count(*) FROM order_notification_outbox) <> 0 OR (SELECT count(*) FROM order_email_delivery_activation) <> 0 OR (SELECT count(*) FROM order_email_deliveries) <> 0 THEN RAISE EXCEPTION 'New email tables must start empty'; END IF; END `$`$;",
    'SELECT count(*) AS metrics_view_rows FROM amazon_product_metrics;',
    $(if ($DryRun) { 'ROLLBACK;' } else { 'COMMIT;' })
)
$vps = Join-Path $env:APPDATA 'chat-on-steroids\skills\hermes-vps\Invoke-HermesVps.ps1'
if (-not (Test-Path -LiteralPath $vps)) { throw 'Hermes VPS SSH helper missing.' }
$script = "set -e`nsudo -n -u postgres psql -X -v ON_ERROR_STOP=1 -d mita <<'MITA_ADDITIVE_SQL_ONLY'`n" +
    ($sql -join "`n") + "`nMITA_ADDITIVE_SQL_ONLY`n"
& $vps -ScriptText $script
if ($LASTEXITCODE -ne 0) { throw "Additive migration failed (exit $LASTEXITCODE)." }
Write-Output $(if ($DryRun) { 'Additive SQL dry-run rolled back' } else { 'Additive SQL committed' })
