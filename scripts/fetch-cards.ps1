#requires -Version 7
<#
.SYNOPSIS
  Downloads the public-domain playing-card deck from Wikimedia Commons.

.DESCRIPTION
  Source category:
    https://commons.wikimedia.org/wiki/Category:Public_domain_playing_cards

  Commons files are named "<Rank> of <Suit>.svg"; they are stored locally as
  public/cards/<CODE>.png (e.g. AS.png, 10H.png, KD.png, BACK.png).

  Two things make this work on a machine that can only reach Wikimedia through
  a local proxy:

    * Requests go through -Proxy (default socks5h://127.0.0.1:10808).
    * We fetch *thumbnails*, not originals. Wikimedia rate-limits direct
      original-file downloads with HTTP 429 + "Retry-After: 600" and explicitly
      asks clients to use the thumbnail service instead. Thumbnails are served
      from thumb.wikimedia.org (CDN-cached) and are not throttled.

  Every download is validated by magic bytes, so a stray error page can never
  end up masquerading as a card.

.EXAMPLE
  pwsh -File scripts/fetch-cards.ps1

.EXAMPLE
  pwsh -File scripts/fetch-cards.ps1 -Proxy '' -Force
#>
[CmdletBinding()]
param(
    [string]$Proxy = 'socks5h://127.0.0.1:10808',
    [string]$OutDir = (Join-Path $PSScriptRoot '..\public\cards'),
    # Standard Wikimedia thumbnail bucket; cards render at <=56 CSS px.
    [int]$Width = 500,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Api = 'https://commons.wikimedia.org/w/api.php'
$UA = 'ShowhandGame/1.0 (local dev; card asset fetch; educational)'

$Suits = @(
    @{ Key = 'S'; Name = 'Spades' }
    @{ Key = 'H'; Name = 'Hearts' }
    @{ Key = 'C'; Name = 'Clubs' }
    @{ Key = 'D'; Name = 'Diamonds' }
)
$Ranks = @(
    @{ Key = 'A'; Name = 'Ace' }, @{ Key = '2'; Name = '2' }, @{ Key = '3'; Name = '3' }
    @{ Key = '4'; Name = '4' }, @{ Key = '5'; Name = '5' }, @{ Key = '6'; Name = '6' }
    @{ Key = '7'; Name = '7' }, @{ Key = '8'; Name = '8' }, @{ Key = '9'; Name = '9' }
    @{ Key = '10'; Name = '10' }, @{ Key = 'J'; Name = 'Jack' }, @{ Key = 'Q'; Name = 'Queen' }
    @{ Key = 'K'; Name = 'King' }
)

function Get-ProxyArgs {
    if ($Proxy) { return @('--proxy', $Proxy) }
    return @()
}

function Invoke-Commons {
    param([string]$Url, [int]$Attempts = 5)
    $proxyArgs = Get-ProxyArgs
    for ($i = 1; $i -le $Attempts; $i++) {
        $out = & curl.exe -s -S --max-time 60 --retry 2 --retry-delay 2 `
            @proxyArgs -A $UA $Url 2>$null
        if ($LASTEXITCODE -eq 0 -and $out) { return $out }
        Start-Sleep -Milliseconds (600 * $i)
    }
    throw "API request failed after $Attempts attempts: $Url"
}

# True only when the file really starts with the PNG signature.
function Test-IsPng {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $false }
    $item = Get-Item $Path
    if ($item.Length -lt 512) { return $false }
    try {
        $stream = [System.IO.File]::OpenRead($Path)
        try {
            $sig = New-Object byte[] 8
            if ($stream.Read($sig, 0, 8) -ne 8) { return $false }
        } finally { $stream.Dispose() }
    } catch { return $false }
    $expected = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
    for ($i = 0; $i -lt 8; $i++) { if ($sig[$i] -ne $expected[$i]) { return $false } }
    return $true
}

function Get-ImageInfo {
    param([string[]]$Titles)
    $map = @{}
    # The Commons API accepts at most 50 titles per query.
    for ($offset = 0; $offset -lt $Titles.Count; $offset += 50) {
        $batch = $Titles[$offset..([Math]::Min($offset + 49, $Titles.Count - 1))]
        $joined = [uri]::EscapeDataString(($batch -join '|'))
        $url = "$Api`?action=query&titles=$joined&prop=imageinfo" +
               "&iiprop=url%7Cextmetadata%7Cmime%7Csize&iiurlwidth=$Width&format=json&formatversion=2"
        $json = Invoke-Commons $url | ConvertFrom-Json
        foreach ($page in $json.query.pages) {
            if ($page.PSObject.Properties.Name -contains 'missing') { continue }
            $ii = $page.imageinfo[0]
            $map[$page.title] = [pscustomobject]@{
                Title     = $page.title
                ThumbUrl  = ($ii.thumburl -split '\?')[0]
                ThumbW    = $ii.thumbwidth
                Original  = ($ii.url -split '\?')[0]
                License   = $ii.extmetadata.LicenseShortName.value
                LicenseId = $ii.extmetadata.License.value
                Artist    = ($ii.extmetadata.Artist.value -replace '<[^>]+>', '').Trim()
                DescUrl   = $ii.descriptionurl
            }
        }
    }
    return $map
}

# ------------------------------------------------------------------ build plan
$plan = [System.Collections.Generic.List[object]]::new()
foreach ($suit in $Suits) {
    foreach ($rank in $Ranks) {
        $plan.Add([pscustomobject]@{
            Code     = "$($rank.Key)$($suit.Key)"
            Title    = "File:$($rank.Name) of $($suit.Name).svg"
            Filename = "$($rank.Key)$($suit.Key).png"
        })
    }
}
$plan.Add([pscustomobject]@{ Code = 'BACK'; Title = 'File:Card back red.svg'; Filename = 'BACK.png' })

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "Output: $((Resolve-Path $OutDir).Path)" -ForegroundColor Cyan
Write-Host "Thumbnail width: ${Width}px`n" -ForegroundColor Cyan

# ------------------------------------------------------------- resolve URLs
Write-Host "Resolving $($plan.Count) thumbnail URLs via the Commons API..." -ForegroundColor Cyan
$info = Get-ImageInfo -Titles ($plan | ForEach-Object { $_.Title })
Write-Host "  resolved $($info.Count)/$($plan.Count)"

$missing = $plan | Where-Object { -not $info.ContainsKey($_.Title) }
if ($missing) {
    Write-Host "  MISSING:" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "    $($_.Title)" -ForegroundColor Red }
}

# ------------------------------------------------------------ license report
$licenses = $info.Values | Group-Object License | Sort-Object Count -Descending
Write-Host "`nLicenses found:" -ForegroundColor Cyan
foreach ($g in $licenses) { Write-Host ("  {0,-28} x{1}" -f $g.Name, $g.Count) }

$nonPd = $info.Values | Where-Object { $_.License -notmatch 'Public domain|PD|CC0' }
if ($nonPd) {
    Write-Host "`nNon-public-domain files detected:" -ForegroundColor Yellow
    $nonPd | Select-Object -First 10 | ForEach-Object { Write-Host "  $($_.Title) -> $($_.License)" }
    if (-not $Force) {
        throw "Aborting: deck is not fully public domain. Re-run with -Force to override."
    }
}

# ------------------------------------------------------------------ download
Get-Process -Name curl -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300

# Drop anything that is not a real PNG (including leftovers from older runs).
$discarded = 0
foreach ($pattern in @('*.png', '*.svg', '*.part')) {
    Get-ChildItem -Path $OutDir -Filter $pattern -ErrorAction SilentlyContinue | ForEach-Object {
        $keep = ($pattern -eq '*.png') -and (Test-IsPng -Path $_.FullName)
        if (-not $keep) {
            Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue
            $script:discarded++
        }
    }
}
if ($discarded -gt 0) { Write-Host "Discarded $discarded stale/invalid file(s)." -ForegroundColor Yellow }

$pending = @()
foreach ($item in $plan) {
    if (-not $info.ContainsKey($item.Title)) { continue }
    $dest = Join-Path $OutDir $item.Filename
    if ((Test-Path $dest) -and -not $Force -and (Test-IsPng -Path $dest)) { continue }
    $pending += [pscustomobject]@{ Url = $info[$item.Title].ThumbUrl; Path = $dest; Name = $item.Filename }
}

$skipped = $plan.Count - $pending.Count
Write-Host "`nDownloading $($pending.Count) thumbnail(s)..." -ForegroundColor Cyan

$proxyArgs = Get-ProxyArgs
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$index = 0
$fail = 0
foreach ($job in $pending) {
    $index++
    $ok = $false
    for ($attempt = 1; $attempt -le 4 -and -not $ok; $attempt++) {
        if (Test-Path $job.Path) { Remove-Item -Force $job.Path -ErrorAction SilentlyContinue }
        & curl.exe -s -S -L --fail --max-time 60 @proxyArgs -A $UA -o $job.Path $job.Url 2>$null
        if ($LASTEXITCODE -eq 0 -and (Test-IsPng -Path $job.Path)) {
            $ok = $true
        } else {
            Remove-Item -Force $job.Path -ErrorAction SilentlyContinue
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
    if ($ok) {
        Write-Host ("  [{0,2}/{1}] ok  {2,-9} {3,7:N0} B" -f $index, $pending.Count, $job.Name, (Get-Item $job.Path).Length) -ForegroundColor DarkGray
    } else {
        $fail++
        Write-Host ("  [{0,2}/{1}] ERR {2}" -f $index, $pending.Count, $job.Name) -ForegroundColor Red
    }
    Start-Sleep -Milliseconds 150
}
$sw.Stop()
Write-Host ("`nDownloaded {0}, already present {1}, failed {2} in {3:N1}s" -f ($pending.Count - $fail), $skipped, $fail, $sw.Elapsed.TotalSeconds) -ForegroundColor Cyan

# -------------------------------------------------------------- attribution
$manifest = [ordered]@{
    source      = 'https://commons.wikimedia.org/wiki/Category:Public_domain_playing_cards'
    fetchedAt   = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    thumbWidth  = $Width
    license     = ($licenses | ForEach-Object { $_.Name }) -join ' / '
    files       = @()
}
foreach ($item in $plan) {
    if (-not $info.ContainsKey($item.Title)) { continue }
    $m = $info[$item.Title]
    $manifest.files += [ordered]@{
        local    = $item.Filename
        title    = $m.Title
        license  = $m.License
        licenseId= $m.LicenseId
        artist   = $m.Artist
        source   = $m.DescUrl
        thumbnail= $m.ThumbUrl
    }
}
$manifestPath = Join-Path $OutDir 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $manifestPath
Write-Host "Wrote $manifestPath" -ForegroundColor Cyan

if ($fail -gt 0) { exit 1 }
