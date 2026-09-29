# Contributing to x402-Handle

Thank you for your interest in contributing to **x402-Handle**! We welcome bug reports, feature requests, documentation improvements, and pull requests.

---

## Code of Conduct & Standards

- Be respectful and constructive in all communications.
- Adhere to the existing code structure, naming conventions, and architectural boundaries.
- Ensure all automated checks and tests pass before requesting review.

---

## Development Setup

This project uses a monorepo structure managed by **Bun** for TypeScript/JavaScript packages and **Cargo** for Soroban smart contracts.

### Prerequisites
- [Bun](https://bun.sh/) (v1.3.13+)
- [Node.js](https://nodejs.org/) (v20+)
- [Rust & Cargo](https://rustup.rs/) (for contracts in `contracts/soroban-registry`)
- [Docker & Docker Compose](https://www.docker.com/) (optional, for local containerized development)

### Getting Started
1. Fork and clone the repository:
   ```bash
   git clone https://github.com/<your-username>/x402-Handle.git
   cd x402-Handle
   ```

2. Install dependencies:
   ```bash
   bun install --frozen-lockfile
   ```

3. Run verification checks:
   ```bash
   bun run verify
   ```

4. Format and lint checks:
   ```bash
   bun run format:check
   ```

---

## Pull Request Guidelines

1. **Create a topic branch**: Branch off `main` or `develop` using a descriptive name (e.g. `feat/feature-name` or `fix/issue-description`).
2. **Commit messages**: Use [Conventional Commits](https://www.conventionalcommits.org/) (e.g. `feat: ...`, `fix: ...`, `docs: ...`, `chore: ...`).
3. **Run CI checks locally**: Always ensure `bun run verify` and formatting pass locally before pushing.
4. **Secret hygiene**: Do not commit secrets, tokens, private keys, or `.env` files. Secret scanning is enforced in CI via Gitleaks.
5. **Open a PR**: Fill out the PR template with clear descriptions of what was changed and why.

---

## Reporting Security Issues

Please **do not** open public issues for security vulnerabilities. Follow our [Security Policy](SECURITY.md) to report security concerns privately.
