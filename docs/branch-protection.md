# Branch Protection Guide: Protecting `main`

This document details how repository administrators can protect the `main` branch to ensure that:
1. Direct pushes to `main` are prevented (all changes must arrive via pull request).
2. All pull requests require the CI `Verify` workflow to pass before merging.
3. Secret scanning checks pass before merging.

---

## 1. Web UI Configuration (GitHub Repository Settings)

Follow these steps in the GitHub Web UI:

### Step 1: Navigate to Branch Protection Settings
1. Open the repository on GitHub: `https://github.com/<owner>/x402-Handle`
2. Click **Settings** (top navigation bar).
3. In the left-hand sidebar, under **Code and automation**, click **Branches**.
4. Click **Add branch protection rule** (or edit the existing rule for `main`).

---

### Step 2: Configure Branch Pattern
- **Branch name pattern**: `main`

---

### Step 3: Configure Pull Request Requirements
Check the following options:
- [x] **Require a pull request before merging**
  - **Require approvals**: Check this box and set minimum approvals to `1` (or desired team policy).
  - [x] **Dismiss stale pull request approvals when new commits are pushed**: Ensures re-approval if new commits are added to an approved PR.
  - [x] **Require review from Code Owners** (optional, if `.github/CODEOWNERS` is used).

---

### Step 4: Require Status Checks (The `Verify` Workflow)
- [x] **Require status checks to pass before merging**
- [x] **Require branches to be up to date before merging**: Ensures the PR is tested against the latest commit on `main`.
- In the search box labeled **Status checks that are required**, search for and select:
  1. `Verify` — This corresponds to the `Verify` job defined in `.github/workflows/ci.yml`.
  2. `Secret Scanning` — This corresponds to the `Secret Scanning` job in `.github/workflows/secret-scanning.yml`.

> [!NOTE]
> If a status check does not appear in the search box immediately, trigger a run of the workflow on a branch or PR first; GitHub will index the check name once it has executed at least once.

---

### Step 5: Enforcement & Safety
Check the following settings to lock down `main`:
- [x] **Do not allow bypassing the above settings**: Enforces the rules on repository administrators as well.
- [ ] **Allow force pushes**: Leave UNCHECKED (disable force pushes to prevent history rewrites).
- [ ] **Allow deletions**: Leave UNCHECKED (prevent deletion of the `main` branch).

---

### Step 6: Save Changes
Click **Create** or **Save changes** at the bottom of the page. Enter your GitHub password/2FA if prompted.

---

## 2. GitHub Ruleset Configuration (Alternative / Modern Approach)

GitHub now supports **Rulesets**, which offer fine-grained branch rules:
1. Navigate to **Settings** > **Rules** > **Rulesets**.
2. Click **New ruleset** > **New branch ruleset**.
3. **Ruleset Name**: `Protect main branch`.
4. **Enforcement status**: `Active`.
5. **Target branches**: Select **Include default branch** (or add `main`).
6. **Rules**:
   - Check **Restrict deletions**
   - Check **Block force pushes**
   - Check **Require a pull request before merging** (Required approvals: `1`)
   - Check **Require status checks to pass**:
     - Add `Verify`
     - Add `Secret Scanning`
     - Require branches to be up to date.
7. Click **Create**.

---

## 3. Automated Configuration via GitHub API / Script

Repository administrators can also apply these settings programmatically using the provided setup scripts:
- **Bash**: [`scripts/setup-branch-protection.sh`](../scripts/setup-branch-protection.sh)
- **PowerShell**: [`scripts/setup-branch-protection.ps1`](../scripts/setup-branch-protection.ps1)

See [`scripts/README.md`](../scripts/README.md) or run:
```bash
export GITHUB_TOKEN="ghp_your_pat_with_repo_scope"
bash scripts/setup-branch-protection.sh KingMavin/x402-Handle main
```
