$ErrorActionPreference = "Stop"

Write-Host "Repurpose Program setup" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js 20+ is required. Install Node.js, then run this script again."
}

$nodeMajor = [int]((node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20+ is required. Current: $(node -v)" }

if (-not (Test-Path .env)) {
  Copy-Item .env.example .env
  Write-Host "Created .env from .env.example"
}

Write-Host "Installing Node dependencies..."
npm install

if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) {
  if (Get-Command py -ErrorAction SilentlyContinue) {
    Write-Host "Installing yt-dlp with Python..."
    py -m pip install -U yt-dlp
  } else {
    Write-Warning "yt-dlp was not found. Install it before running media workflows."
  }
}

Write-Host "\nSetup complete." -ForegroundColor Green
Write-Host "1. Fill in .env with your platform developer credentials."
Write-Host "2. Run: npm start"
Write-Host "3. Open: http://localhost:3080"
