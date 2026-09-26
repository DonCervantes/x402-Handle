import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const workspaceNames = new Set([
  "contracts",
  "sources",
  "intelligence",
  "agent-sdk",
  "x402-stellar",
  "cli",
  "data",
  "bff",
  "frontend",
]);

const workspaceRoots = [
  { kind: "package", name: "contracts", root: path.join(root, "packages", "contracts") },
  { kind: "package", name: "sources", root: path.join(root, "packages", "sources") },
  { kind: "package", name: "intelligence", root: path.join(root, "packages", "intelligence") },
  { kind: "package", name: "agent-sdk", root: path.join(root, "packages", "agent-sdk") },
  { kind: "package", name: "x402-stellar", root: path.join(root, "packages", "x402-stellar") },
  { kind: "app", name: "cli", root: path.join(root, "apps", "cli") },
  { kind: "app", name: "data", root: path.join(root, "apps", "data") },
  { kind: "app", name: "bff", root: path.join(root, "apps", "bff") },
  { kind: "app", name: "frontend", root: path.join(root, "apps", "frontend") },
] as const;

type Workspace = (typeof workspaceRoots)[number];

const packageAllowedImports = new Map<string, ReadonlySet<string>>([
  ["contracts", new Set()],
  ["sources", new Set(["contracts"])],
  ["intelligence", new Set(["contracts"])],
  ["agent-sdk", new Set(["contracts", "x402-stellar"])],
  ["x402-stellar", new Set(["contracts"])],
]);

const ignoredDirectories = new Set([".git", "node_modules", "dist", "reports", "tmp"]);

const listTypeScriptFiles = (directory: string): string[] => {
  const files: string[] = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(fullPath));
    } else if (entry.isFile() && /\.tsx?$/.test(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
};

const findWorkspace = (filePath: string): Workspace | null => {
  const normalized = path.resolve(filePath);
  return (
    workspaceRoots.find((workspace) => normalized.startsWith(`${workspace.root}${path.sep}`)) ??
    null
  );
};

const readImportSpecifiers = (source: string): string[] => {
  const specifiers: string[] = [];
  const patterns = [
    /^\s*import\s+(?:type\s+)?(?:[\w*\s{},$]+\s+from\s+)?["']([^"']+)["']/gm,
    /^\s*export\s+(?:type\s+)?(?:[\w*\s{},$]+\s+from\s+)["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.push(match[1]);
    }
  }

  return specifiers;
};

const workspaceNameForSpecifier = (specifier: string, fromFile: string): string | null => {
  if (specifier.startsWith(".")) {
    const target = path.resolve(path.dirname(fromFile), specifier);
    return findWorkspace(target)?.name ?? null;
  }

  if (specifier === "@flovia/x402-stellar" || specifier.startsWith("@flovia/x402-stellar/")) {
    return "x402-stellar";
  }
  if (specifier === "@flovia/agent-sdk" || specifier.startsWith("@flovia/agent-sdk/")) {
    return "agent-sdk";
  }

  const [firstSegment] = specifier.split("/");
  return firstSegment && workspaceNames.has(firstSegment) ? firstSegment : null;
};

export interface BoundaryCheckResult {
  violations: string[];
  ok: boolean;
}

export function checkImportBoundaries(customBaseDir?: string): BoundaryCheckResult {
  const baseDir = customBaseDir ? path.resolve(customBaseDir) : root;
  const violations: string[] = [];

  for (const workspace of workspaceRoots) {
    for (const file of listTypeScriptFiles(workspace.root)) {
      let source = "";
      try {
        source = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const specifiers = readImportSpecifiers(source);

      for (const specifier of specifiers) {
        const targetWorkspace = workspaceNameForSpecifier(specifier, file);
        if (!targetWorkspace || targetWorkspace === workspace.name) continue;

        if (workspace.kind === "package") {
          const allowed = packageAllowedImports.get(workspace.name) ?? new Set<string>();
          if (!allowed.has(targetWorkspace)) {
            violations.push(
              `${path.relative(baseDir, file)} imports ${specifier}; packages/${workspace.name} may not depend on ${targetWorkspace}`,
            );
          }
        }

        if (workspace.name === "bff" && targetWorkspace === "cli") {
          violations.push(
            `${path.relative(baseDir, file)} imports ${specifier}; apps/bff may not depend on apps/cli`,
          );
        }

        if (workspace.name === "data") {
          violations.push(
            `${path.relative(baseDir, file)} imports ${specifier}; apps/data may not depend on other workspaces`,
          );
        }

        if (workspace.name === "frontend" && !new Set(["contracts"]).has(targetWorkspace)) {
          violations.push(
            `${path.relative(baseDir, file)} imports ${specifier}; apps/frontend may only depend on packages/contracts`,
          );
        }
      }
    }
  }

  return {
    violations,
    ok: violations.length === 0,
  };
}

export function main(): void {
  const result = checkImportBoundaries();
  if (!result.ok) {
    console.error(
      ["Import boundary violations:", ...result.violations.map((item) => `- ${item}`)].join("\n"),
    );
    process.exit(1);
  }

  console.log("Import boundaries OK");
}

if (import.meta.main) {
  main();
}
