$out = Join-Path $env:APPDATA "Nexora\localhostrun.log"
$err = Join-Path $env:APPDATA "Nexora\localhostrun.err.log"

if (Test-Path $out) {
  Remove-Item $out -Force
}

if (Test-Path $err) {
  Remove-Item $err -Force
}

Start-Process -FilePath "ssh.exe" `
  -ArgumentList @(
    "-T",
    "-o", "StrictHostKeyChecking=no",
    "-o", "ServerAliveInterval=30",
    "-R", "80:localhost:3210",
    "nokey@localhost.run"
  ) `
  -RedirectStandardOutput $out `
  -RedirectStandardError $err `
  -WindowStyle Hidden

Start-Sleep -Seconds 10

if (Test-Path $out) {
  Get-Content $out
}

if (Test-Path $err) {
  Get-Content $err
}
