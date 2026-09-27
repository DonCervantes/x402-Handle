const scriptName = Bun.argv[2];

const supportedScripts = new Set(["test", "typecheck", "verify"]);

if (!scriptName || !supportedScripts.has(scriptName)) {
  console.error("Usage: bun scripts/run-workspace-script.ts <test|typecheck|verify>");
  process.exit(1);
}

const workspaces = [
  "packages/contracts",
  "packages/sources",
  "packages/intelligence",
  "packages/x402-stellar",
  "apps/cli",
  "apps/data",
  "apps/bff",
  "apps/frontend",
] as const;

for (const workspace of workspaces) {
  console.log(`\n> ${workspace}: bun run ${scriptName}`);

  const child = Bun.spawn(["bun", "run", scriptName], {
    cwd: workspace,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
