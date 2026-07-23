[CmdletBinding()]
param(
  [string]$InstallRoot = 'E:\TencentMeetingCoachLocal',
  [string]$LlmModel = 'qwen3.5:9b'
)

$ErrorActionPreference = 'Stop'
$senseName = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17'
$ollamaUrl = 'https://github.com/ollama/ollama/releases/latest/download/ollama-windows-amd64.zip'
$senseUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2'
$vadUrl = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
$downloadDir = Join-Path $InstallRoot 'downloads'
$ollamaDir = Join-Path $InstallRoot 'ollama'
$ollamaModels = Join-Path $InstallRoot 'models\ollama'
$senseRoot = Join-Path $InstallRoot 'models\sensevoice'
$senseDir = Join-Path $senseRoot $senseName
$vadRoot = Join-Path $InstallRoot 'models\vad'
$vadModel = Join-Path $vadRoot 'silero_vad.onnx'
$pythonDir = Join-Path $InstallRoot 'runtime\python'
$python311Dir = Join-Path $InstallRoot 'runtime\python311'
$funasrRoot = Join-Path $InstallRoot 'models\funasr'
$torchRoot = Join-Path $InstallRoot 'models\torch'
$ollamaZip = Join-Path $downloadDir 'ollama-windows-amd64.zip'
$senseArchive = Join-Path $downloadDir 'sensevoice.tar.bz2'
$python311Installer = Join-Path $downloadDir 'python-3.11.9-amd64.exe'
$python311Url = 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe'
$torchWheel = Join-Path $downloadDir 'torch-2.11.0+cpu-cp311-cp311-win_amd64.whl'
$torchaudioWheel = Join-Path $downloadDir 'torchaudio-2.11.0+cpu-cp311-cp311-win_amd64.whl'
$torchUrl = 'https://download-r2.pytorch.org/whl/cpu/torch-2.11.0%2Bcpu-cp311-cp311-win_amd64.whl'
$torchaudioUrl = 'https://download-r2.pytorch.org/whl/cpu/torchaudio-2.11.0%2Bcpu-cp311-cp311-win_amd64.whl'
$torchSha256 = '51a221769d4a316f4b47a786c12e67c3f4807db8ed13c7b8817ebe73786acbbc'
$torchaudioSha256 = 'abbff04127caf6e16e3a7c3e1ca2739b68899e14926d7cbec4bd8b40f72375d5'

function Download-Resume([string]$Url, [string]$Destination) {
  Write-Host "Downloading $Url"
  & curl.exe -L --fail --retry 8 --retry-all-errors --connect-timeout 20 -C - -o $Destination $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}

foreach ($directory in @($InstallRoot, $downloadDir, $ollamaDir, $ollamaModels, $senseRoot, $vadRoot, $pythonDir, $funasrRoot, $torchRoot)) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}

if (-not (Test-Path -LiteralPath (Join-Path $ollamaDir 'ollama.exe'))) {
  Download-Resume $ollamaUrl $ollamaZip
  Expand-Archive -LiteralPath $ollamaZip -DestinationPath $ollamaDir -Force
}

if (-not (Test-Path -LiteralPath (Join-Path $senseDir 'model.int8.onnx'))) {
  Download-Resume $senseUrl $senseArchive
  & tar.exe -xf $senseArchive -C $senseRoot
  if ($LASTEXITCODE -ne 0) { throw 'SenseVoice extraction failed.' }
}

if (-not (Test-Path -LiteralPath $vadModel)) {
  Download-Resume $vadUrl $vadModel
}

$pythonExe = Join-Path $pythonDir 'Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExe)) {
  $systemPython = (Get-Command python -ErrorAction Stop).Source
  & $systemPython -m venv $pythonDir
}
& $pythonExe -m pip install --upgrade pip
& $pythonExe -m pip install --no-cache-dir 'sherpa-onnx==1.13.4' numpy

# FunASR/PyTorch currently require a stable Python version. Keep this runtime
# separate from an existing system Python and place it, its caches and models on E:.
$python311Exe = Join-Path $python311Dir 'python.exe'
if (-not (Test-Path -LiteralPath $python311Exe)) {
  if (-not (Test-Path -LiteralPath $python311Installer)) {
    Download-Resume $python311Url $python311Installer
  }
  $install = Start-Process -FilePath $python311Installer -ArgumentList @(
    '/quiet',
    'InstallAllUsers=0',
    "TargetDir=$python311Dir",
    'PrependPath=0',
    'Include_launcher=0',
    'Include_test=0',
    'Shortcuts=0'
  ) -WindowStyle Hidden -Wait -PassThru
  if ($install.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $python311Exe)) {
    throw "Python 3.11 installation failed with exit code $($install.ExitCode)."
  }
}

function Download-Verified([string]$Url, [string]$Destination, [string]$Sha256) {
  if (Test-Path -LiteralPath $Destination) {
    $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -eq $Sha256) { return }
  }
  Download-Resume $Url $Destination
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) { throw "Checksum mismatch: $Destination" }
}

$env:MODELSCOPE_CACHE = $funasrRoot
$env:TORCH_HOME = $torchRoot
$env:HF_HOME = Join-Path $funasrRoot 'huggingface'
$env:MODELSCOPE_DOWNLOAD_PARALLEL_WORKERS = '8'
$env:MODELSCOPE_DOWNLOAD_MAX_RETRIES = '10'
$env:MODELSCOPE_DOWNLOAD_TIMEOUT = '120'
& $python311Exe -m pip install --upgrade pip wheel 'setuptools<82'
Download-Verified $torchUrl $torchWheel $torchSha256
Download-Verified $torchaudioUrl $torchaudioWheel $torchaudioSha256
& $python311Exe -m pip install --no-cache-dir $torchWheel $torchaudioWheel
& $python311Exe -m pip install --no-cache-dir 'sherpa-onnx==1.13.4' 'funasr==1.3.14' 'modelscope==1.38.1' numpy
$downloader = Join-Path $PSScriptRoot 'download-funasr-model.py'
$funasrSnapshot = Join-Path $funasrRoot 'models\iic--speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online\snapshots\master'
$funasrModel = Join-Path $funasrSnapshot 'model.pt'
if (Test-Path -LiteralPath $downloader) {
  & $python311Exe $downloader --destination $funasrModel --workers 8
  if ($LASTEXITCODE -ne 0) { throw 'Parallel FunASR model download failed.' }
}
& $python311Exe -c "from funasr import AutoModel; AutoModel(model='paraformer-zh-streaming', disable_update=True, disable_pbar=True, device='cpu'); print('FunASR streaming model ready')"
if ($LASTEXITCODE -ne 0) { throw 'FunASR model download or warm-up failed.' }

[Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $ollamaModels, 'User')
$env:OLLAMA_MODELS = $ollamaModels
$env:OLLAMA_HOST = '127.0.0.1:11434'

try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
} catch {
  Start-Process -FilePath (Join-Path $ollamaDir 'ollama.exe') -ArgumentList @('serve') -WindowStyle Hidden
  $ready = $false
  for ($index = 0; $index -lt 60; $index += 1) {
    try {
      Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/version' -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) { throw 'Ollama did not become ready.' }
}

& (Join-Path $ollamaDir 'ollama.exe') pull $LlmModel
if ($LASTEXITCODE -ne 0) { throw "Ollama model pull failed: $LlmModel" }

Write-Host ''
Write-Host 'Local deployment is ready.' -ForegroundColor Green
Write-Host "Root: $InstallRoot"
Write-Host "LLM:  $LlmModel"
Write-Host "ASR:  $senseName"
Write-Host 'Live: paraformer-zh-streaming (FunASR)'
Write-Host "VAD:  $vadModel"
