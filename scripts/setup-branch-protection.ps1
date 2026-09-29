# setup-branch-protection.ps1
# Automates GitHub branch protection rule configuration for main branch
# Usage:
#   $env:GITHUB_TOKEN = "ghp_xxx"
#   .\scripts\setup-branch-protection.ps1 [-Repo "KingMavin/x402-Handle"] [-Branch "main"]

param (
    [string]$Repo = "",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Repo)) {
    $remoteUrl = git remote get-url origin 2>$null
    if ($remoteUrl -match 'github\.com[:/]([^/]+/[^/\.]+)(\.git)?$') {
        $Repo = $Matches[1]
    } else {
        Write-Error "Repository not specified and could not be detected from git remote origin. Specify -Repo 'owner/repo'."
        exit 1
    }
}

$token = $env:GITHUB_TOKEN
if ([string]::IsNullOrWhiteSpace($token)) {
    # Check if gh CLI has a token
    $ghPath = Get-Command gh -ErrorAction SilentlyContinue
    if ($ghPath) {
        $token = gh auth token 2>$null
    }
}

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "GITHUB_TOKEN environment variable is required or 'gh auth login' must be configured."
    exit 1
}

Write-Host "Configuring branch protection for $Repo (branch: $Branch)..."
Write-Host "Requiring status checks: 'Verify' and 'Secret Scanning'..."

$headers = @{
    "Accept" = "application/vnd.github+json"
    "Authorization" = "Bearer $token"
    "X-GitHub-Api-Version" = "2022-11-28"
}

$body = @{
    required_status_checks = @{
        strict = $true
        contexts = @("Verify", "Secret Scanning")
    }
    enforce_admins = $true
    required_pull_request_reviews = @{
        dismiss_stale_reviews = $true
        require_code_owner_reviews = $false
        required_approving_review_count = 1
    }
    restrictions = $null
    allow_force_pushes = $false
    allow_deletions = $false
    required_conversation_resolution = $true
} | ConvertTo-Json -Depth 5

$url = "https://api.github.com/repos/$Repo/branches/$Branch/protection"

try {
    $response = Invoke-RestMethod -Uri $url -Method Put -Headers $headers -Body $body -ContentType "application/json"
    Write-Host "Successfully configured branch protection for '$Branch' on '$Repo'!" -ForegroundColor Green
    Write-Host "Pulls now require the 'Verify' and 'Secret Scanning' workflows." -ForegroundColor Green
} catch {
    Write-Error "Failed to configure branch protection: $_"
    if ($_.Exception.Response) {
        $stream = $_.Exception.Response.GetResponseStream()
        $reader = New-Object System.IO.StreamReader($stream)
        Write-Host $reader.ReadToEnd() -ForegroundColor Red
    }
    exit 1
}
