$port = if ($env:NEXORA_TUNNEL_PORT) { $env:NEXORA_TUNNEL_PORT } else { "3000" }
$out = Join-Path $env:APPDATA "Nexora\localhostrun.log"
$err = Join-Path $env:APPDATA "Nexora\localhostrun.err.log"

if (Test-Path $out) {
  try {
    Remove-Item $out -Force -ErrorAction Stop
  } catch {
    Clear-Content $out -ErrorAction SilentlyContinue
  }
}

if (Test-Path $err) {
  try {
    Remove-Item $err -Force -ErrorAction Stop
  } catch {
    Clear-Content $err -ErrorAction SilentlyContinue
  }
}

Start-Process -FilePath "ssh.exe" `
  -ArgumentList @(
    "-T",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-R", "80:localhost:$port",
    "nokey@localhost.run"
  ) `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -WindowStyle Hidden

$publicUrl = $null

for ($i = 0; $i -lt 20 -and -not $publicUrl; $i++) {
  Start-Sleep -Seconds 1

  if (-not (Test-Path $out)) {
    continue
  }

  $content = Get-Content $out
  $tunnelLine = $content | Select-String -Pattern 'tunneled with tls termination, https://[^\s]+' | Select-Object -Last 1

  if ($tunnelLine) {
    $publicUrl = [regex]::Match($tunnelLine.Line, 'https://[^\s]+').Value
  }
}

Write-Output "Tunnel target: localhost:$port"

if ($publicUrl) {
    Write-Output "Public URL: $publicUrl"
    Write-Output "Webhook URL: $publicUrl/webhook"
} elseif (Test-Path $out) {
  $content = Get-Content $out
  if ($content) {
    $content
  }
}

if (Test-Path $err) {
  $errors = Get-Content $err
  if ($errors) {
    $errors
  } else {
    Write-Output "Tunnel stderr: sin errores"
  }
}
