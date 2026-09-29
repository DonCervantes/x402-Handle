# Repository Governance & Security Settings

This guide documents the hosted repository settings that must be configured by repository administrators in GitHub Settings to ensure full compliance with repository security, secret scanning, and branch protection requirements.

---

## 1. Secret Scanning & Push Protection

GitHub provides native secret scanning to detect known tokens and credentials.

### How to Enable Secret Scanning:
1. Navigate to your repository on GitHub: `https://github.com/<owner>/x402-Handle`
2. Click **Settings** in the top navigation bar.
3. In the left-hand sidebar under **Security**, click **Code security and analysis** (or **Code security**).
4. Locate the **Secret scanning** section:
   - Click **Enable** next to **Secret scanning**.
5. Locate the **Push protection** option under Secret scanning:
   - Click **Enable** next to **Push protection**.
   - *Push protection blocks commits containing secrets before they can even be pushed to GitHub.*

> [!TIP]
> In addition to GitHub's native hosted secret scanning, this repository includes an automated CI check via [`.github/workflows/secret-scanning.yml`](../.github/workflows/secret-scanning.yml) running Gitleaks on all pull requests and pushes.

---

## 2. Dependabot Alerts & Security Updates

1. In repository **Settings** > **Code security and analysis**:
   - **Dependabot alerts**: Click **Enable**.
   - **Dependabot security updates**: Click **Enable**.
2. Scheduled version updates are governed by [`.github/dependabot.yml`](../.github/dependabot.yml), which automatically checks:
   - Root npm/Bun workspaces (`/`)
   - Soroban Rust contracts (`/contracts/soroban-registry`)
   - GitHub Actions workflows (`/`)

---

## 3. Private Vulnerability Reporting

To allow researchers to privately disclose security vulnerabilities as specified in [`SECURITY.md`](../SECURITY.md):
1. In repository **Settings** > **Code security and analysis**:
2. Locate **Private vulnerability reporting**.
3. Click **Enable**.
4. This enables the "Report a vulnerability" button under the repository's **Security** > **Advisories** tab.

---

## 4. Branch Protection Summary

Branch protection for `main` prevents direct pushes and requires the `Verify` CI workflow before pull requests can be merged.

Refer to the full step-by-step instructions in [`docs/branch-protection.md`](branch-protection.md).
