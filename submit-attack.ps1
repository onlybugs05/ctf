$attackCode = Get-Content -Path "contracts\attack.sol" -Raw
$body = @{
    code = $attackCode
    replayMode = $false
} | ConvertTo-Json

try {
    $response = Invoke-WebRequest -Uri "http://localhost:3000/submit-attack" -Method POST -Body $body -ContentType "application/json"
    Write-Host "Status:" $response.StatusCode
    Write-Host "Response:"
    $response.Content | ConvertFrom-Json | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error:" $_.Exception.Message
    if ($_.ErrorDetails) {
        Write-Host "Details:" $_.ErrorDetails.Message
    }
}
