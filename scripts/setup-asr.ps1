# Creates the speech engine's own Python runtime in <project>/runtime/asr: torch (CUDA 12.4 build, also runs on CPU)
# and NeMo, pinned in src/services/asr/requirements-nemo.txt. The app runs the Egyptian model
# (src/services/asr/models/asr-egyptian-nemo-v2.0.nemo) only with this runtime — never a Python from elsewhere.
# Needs Python 3.11 (py launcher or python on PATH) and about 6 GB of disk. Usage: npm run setup:asr
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root "runtime\asr"
$req = Join-Path $root "src\services\asr\requirements-nemo.txt"
$model = Join-Path $root "src\services\asr\models\asr-egyptian-nemo-v2.0.nemo"

$py = $null; $pyArgs = @()
try { & py -3.11 -c "import sys" 2>$null; if ($LASTEXITCODE -eq 0) { $py = "py"; $pyArgs = @("-3.11") } } catch {}
if (-not $py) {
  $v = & python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
  if ($v -eq "3.11") { $py = "python" } else { throw "Python 3.11 is required (found: $v)" }
}

if (-not (Test-Path (Join-Path $runtime "Scripts\python.exe"))) {
  Write-Host "Creating $runtime"
  & $py @pyArgs -m venv $runtime
}
$rpy = Join-Path $runtime "Scripts\python.exe"
& $rpy -m pip install --upgrade pip
& $rpy -m pip install -r $req --extra-index-url https://download.pytorch.org/whl/cu124
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }

if (-not (Test-Path $model)) { Write-Warning "The model file is missing: $model" }
& $rpy -X utf8 (Join-Path $root "src\services\asr\nemo_words.py") --audio - --check --model $model
