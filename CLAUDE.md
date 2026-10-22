# Development style

Develop using TDD (explore → Red → Green → Refactor).
If KPI or coverage targets are provided, iterate until they are met.
Ask clarifying questions for unclear instructions.

# Code design

- Keep separation of concerns
- Separate state and logic
- Prioritize readability and maintainability
- Define contract layers (API/types) strictly, and keep implementation layers regenerable
- Write enforceable static rules as linter or ast-grep rules, not in prompts

# Tooling

- Tasks: bun scripts
- Bun
- Typescript 6

# Repository structure

- Use Bun workspaces (`apps/*`, `packages/*`).
- Current main implementation is in `apps/cli`.

# Setup

- Install dependencies: `bun install`
- If `.env` is needed, use `apps/cli/.env.example`.

# Verification

- After changes, run `bun run verify` from the repository root as a baseline.
- `verify` is the standard gate for typecheck, test, and offline verification.
- Run `bun run format:check` when formatting validation is needed.
- Use Bun test for tests.
- Treat TypeScript as strict.

# Formatting

- Use Biome as the formatter.
- Linting is intentionally disabled in the early stage.
- Target TypeScript and JSON first; do not include Markdown/docs or report outputs.
- Run `bun run format` as needed after changes.
- For PoC speed, formatting is not yet included in `verify`.

# Execution policy

- Keep default verification offline.
- Do not mix live RPC or external service dependent verification into normal `verify`.
- Separate live verification into explicit dedicated commands when needed.

# Artifacts and secrets

- Do not include `.env`, DB files, report outputs, `dist`, or `node_modules` in git.
- Keep outputs re-creatable so they are not required for operation.
- Docs should be authored in English.

# Commit

- Use Conventional Commits.
- Do not add `Co-Authored-By` unless explicitly requested by the user.
- Format: `<type>: <short description>`
- `scope` is optional and should be in parentheses, e.g., `feat(cli): add fixture capture`.
- Do not use custom types like `cli:`; use scope as `feat(cli):` / `fix(cli):`.
- Indicate breaking changes with `!` or `BREAKING CHANGE:` footer.
- Use lowercase subject, imperative mood, no period, within 72 characters.
- Body is optional. When present, add a blank Line after the subject and wrap at 72 characters.

Types:

- `feat`: new feature
- `fix`: bug fix
- `refactor`: refactoring (no behavior change)
- `chore`: maintenance, configuration, dependencies, CI
- `docs`: docs only
- `test`: tests added or updated
- `perf`: performance improvement
- `style`: formatting or whitespace (no logic change)
- `revert`: revert prior commit

# Audit closure policy

- An audit issue is marked completed only after its fix is merged to `main`.
- A Wave application or an open pull request is not completion.
- For each closed-completed audit issue, either merge its designated PR to `main` or close the PR with a written reason.
- When multiple PRs address the same issue, choose one and close the duplicates with a written reason.
- Do not open a new implementation PR when an existing PR already covers the issue.
