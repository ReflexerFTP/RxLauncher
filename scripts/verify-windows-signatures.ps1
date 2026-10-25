[CmdletBinding()]
param(
    [string]$DistPath,
    [string]$Version,
    [string]$PublisherName = $env:RXLAUNCHER_PUBLISHER_NAME
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if ([string]::IsNullOrWhiteSpace($DistPath)) {
    $DistPath = Join-Path $projectRoot 'dist'
}
if ([string]::IsNullOrWhiteSpace($Version)) {
    $package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $Version = [string]$package.version
}
if ([string]::IsNullOrWhiteSpace($PublisherName)) {
    throw 'RXLAUNCHER_PUBLISHER_NAME is required to verify the expected release publisher'
}

$targets = @(
    # NSIS-ядро (его же скачивает автообновление). «RxLauncher Setup» — собственная обёртка, подписывается отдельно
    (Join-Path $DistPath "RxLauncher-Core-$Version.exe"),
    (Join-Path $DistPath 'win-unpacked\RxLauncher.exe'),
    (Join-Path $DistPath 'win-unpacked\resources\elevate.exe')
)

$results = foreach ($target in $targets) {
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
        throw "Signed release artifact is missing: $target"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $target
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) {
        throw "Invalid or untrusted Authenticode signature: $target [$($signature.Status)]"
    }
    if (-not $signature.TimeStamperCertificate) {
        throw "Trusted timestamp is missing: $target"
    }
    [pscustomobject]@{
        Path = (Resolve-Path -LiteralPath $target).Path
        Subject = $signature.SignerCertificate.Subject
        Thumbprint = $signature.SignerCertificate.Thumbprint
        TimestampSubject = $signature.TimeStamperCertificate.Subject
        Status = [string]$signature.Status
    }
}

$subjects = @($results.Subject | Sort-Object -Unique)
if ($subjects.Count -ne 1) {
    throw "Release artifacts were signed by different publishers: $($subjects -join ' | ')"
}
if ($subjects[0].Trim() -ne $PublisherName.Trim()) {
    throw "Release publisher does not match RXLAUNCHER_PUBLISHER_NAME: $($subjects[0])"
}

$results | Format-Table -AutoSize
Write-Output "Verified trusted RxLauncher publisher: $($subjects[0])"
