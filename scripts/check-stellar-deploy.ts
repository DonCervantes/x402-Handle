// Fails if a deploy/seed script (or non-test contract code) uses a
// placeholder where a real on-chain address is required, e.g. a
// `payment_token` from Address::generate instead of the network's USDC SAC.
// Runs as part of `bun run verify`.
import fs from "node:fs";
import path from "node:path";

export interface Finding {
  file: string;
  line: number;
  rule: string;
}

const RULES: ReadonlyArray<{ rule: string; pattern: RegExp }> = [
  {
    rule: "Address::generate is test-only; use the network's USDC SAC",
    pattern: /Address::generate\s*\(/,
  },
  {
    rule: "random address used as an on-chain argument",
    pattern: /\b(?:Address|Keypair)\.random\s*\(/,
  },
  {
    rule: "placeholder payment_token",
    pattern: /PAYMENT_TOKEN_PLACEHOLDER|payment_token[^\n]*placeholder/i,
  },
];

/** Drops `#[cfg(test)] mod … { … }` blocks from Rust source, keeping line numbers. */
export function stripRustTestModules(source: string): string {
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[cfg\(test\)\]/.test(lines[i])) continue;
    let depth = 0;
    let opened = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          opened = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      lines[j] = "";
      if (opened && depth === 0) {
        i = j;
        break;
      }
    }
  }
  return lines.join("\n");
}

export function findPlaceholders(file: string, source: string): Finding[] {
  const code = file.endsWith(".rs") ? stripRustTestModules(source) : source;
  const findings: Finding[] = [];
  code.split("\n").forEach((text, index) => {
    for (const { rule, pattern } of RULES) {
      if (pattern.test(text)) findings.push({ file, line: index + 1, rule });
    }
  });
  return findings;
}

const ROOTS = ["apps/cli/scripts", "apps/demo-provider/src", "scripts/deploy", "contracts"];
const EXTENSIONS = /\.(ts|sh|rs)$/;
const IGNORED = new Set(["node_modules", "target", ".git", "test_snapshots"]);

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (IGNORED.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listFiles(full);
    return EXTENSIONS.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dir, "..");
  const findings = ROOTS.flatMap((r) => listFiles(path.join(root, r))).flatMap((file) =>
    findPlaceholders(path.relative(root, file), fs.readFileSync(file, "utf8")),
  );
  for (const f of findings) console.error(`${f.file}:${f.line}: ${f.rule}`);
  if (findings.length > 0) process.exit(1);
  console.log("Stellar deploy placeholder check passed.");
}
