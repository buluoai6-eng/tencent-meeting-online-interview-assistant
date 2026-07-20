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
$ollamaZip = Join-Path $downloadDir 'ollama-windows-amd64.zip'
$senseArchive = Join-Path $downloadDir 'sensevoice.tar.bz2'

function Download-Resume([string]$Url, [string]$Destination) {
  Write-Host "Downloading $Url"
  & curl.exe -L --fail --retry 8 --retry-all-errors --connect-timeout 20 -C - -o $Destination $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
}

foreach ($directory in @($InstallRoot, $downloadDir, $ollamaDir, $ollamaModels, $senseRoot, $vadRoot, $pythonDir)) {
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
Write-Host "VAD:  $vadModel"
