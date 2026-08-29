PR Title: chore(soroban-registry): audit checklist, threat model, README fixes

PR Body:
Adds audit checklist and threat model for `contracts/soroban-registry`, and updates the README to reference HANDLE and correct the build path.

Files changed:
- docs/soroban-registry-audit-checklist.md
- docs/soroban-registry-threat-model.md
- contracts/soroban-registry/README.md

This PR is part of Epic #31: audit soroban-registry and run it on Stellar (testnet → mainnet).

---

Commands to run locally (from repo root):

```bash
# create branch
git checkout -b feature/soroban-registry-audit

# stage changes
git add docs/soroban-registry-audit-checklist.md docs/soroban-registry-threat-model.md contracts/soroban-registry/README.md

# commit
git commit -m "chore(soroban-registry): add audit checklist and threat model; update README for HANDLE and build path"

# push branch
git push -u origin feature/soroban-registry-audit

# create PR (using GitHub CLI)
gh pr create --title "chore(soroban-registry): audit checklist, threat model, README fixes" \
  --body-file .github/PRs/feature-soroban-registry-audit-pr.md --base main
```

If you don't have `gh`, open this URL in a browser to create the PR:

https://github.com/DonCervantes/x402-Handle/compare/main...feature/soroban-registry-audit?expand=1
