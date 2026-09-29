# Security Policy

The Flovia / x402-Handle team takes the security of our software products, smart contracts, and services seriously. We appreciate the responsible disclosure of security vulnerabilities by researchers and community members.

---

## Supported Versions

We release patches and security fixes for currently maintained branches and releases.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |
| `< 0.1` | :x:                |

---

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

### Preferred Method: GitHub Private Vulnerability Reporting
If you have discovered a vulnerability in this repository, please report it via GitHub's Private Vulnerability Reporting:
1. Navigate to the [Security tab](../../security) of the repository.
2. Select **Advisories** on the left sidebar.
3. Click **Report a vulnerability** to open the advisory draft form.
4. Provide a detailed summary, severity assessment, reproduction steps, and proof-of-concept (PoC).

### Alternative Method: Direct Security Contact
If you are unable to use GitHub Security Advisories, send an email describing the issue to:
- **Email**: `security@flovia.xyz` (or open a confidential inquiry with repository maintainers)

### Information to Include in Your Report
To help us triage and resolve the issue quickly, please include:
- A clear description of the vulnerability and its potential impact.
- Affected components (contracts, backend BFF, CLI, frontend, or SDK).
- Step-by-step instructions or scripts to reproduce the issue.
- Potential mitigations or remediations if known.

---

## Response Process & SLA

- **Acknowledgment**: We aim to acknowledge receipt of security reports within **48 hours**.
- **Assessment**: We will evaluate severity, reproduce the finding, and determine impacted systems within **5 business days**.
- **Remediation**: Once verified, we will develop and test a fix in a private advisory fork.
- **Coordinated Disclosure**: We adhere to coordinated vulnerability disclosure. A public CVE/security advisory and release will be issued alongside the fix once deployed.

---

## Safe Harbor

We consider activities conducted under this policy to be authorized and protected under safe harbor guidelines:
- We will not pursue civil or criminal action against researchers acting in good faith.
- You must make a good-faith effort to avoid privacy violations, destruction of data, and interruption or degradation of our services or contracts.
- Do not exploit a security issue to gain unauthorized access to funds or personal data beyond the minimum necessary to demonstrate the proof-of-concept.
