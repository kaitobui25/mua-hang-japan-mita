# Standalone detail scheduler: shared lifecycle owns llama and workers.
# The real GGUF server starts only for an inference request, then idles out.
[CmdletBinding()]
param()
$ErrorActionPreference='Stop'
& (Join-Path $PSScriptRoot 'start-mita-supervisor.ps1') -DetailOnly
