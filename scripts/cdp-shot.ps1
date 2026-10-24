param([string]$JsonPath, [string]$OutPath)
$json = Get-Content $JsonPath -Raw | ConvertFrom-Json
$b64 = if ($json.result) { $json.result.data } else { $json.data }
$bytes = [Convert]::FromBase64String($b64)
[System.IO.File]::WriteAllBytes($OutPath, $bytes)
Write-Output "$OutPath  $([math]::Round($bytes.Length/1024)) KB"
