// One-off review helper (not part of the build): checks every controller for
// decorators whose import is missing, and for this.X references to properties
// that were never declared as constructor-injected fields.
const fs = require('fs');
const path = require('path');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

const issues = [];
for (const file of walk('src').filter((f) => f.endsWith('.ts'))) {
  const src = fs.readFileSync(file, 'utf8');
  const importMatch = src.match(/import\s*\{([^}]*)\}\s*from\s*'@nestjs\/common'/);
  const imported = new Set((importMatch ? importMatch[1] : '').split(',').map((s) => s.trim()).filter(Boolean));
  const bodyWithoutImports = src.replace(/^import[^\n]*$/gm, '');

  const decorators = ['Query', 'Headers', 'Param', 'Res', 'Body', 'Get', 'Post', 'Put', 'Patch', 'Delete', 'All', 'UseGuards', 'HttpCode', 'Inject', 'Optional', 'Controller', 'Injectable', 'Module'];
  for (const dec of decorators) {
    const uses = bodyWithoutImports.includes('@' + dec + '(') || bodyWithoutImports.includes('@' + dec + ' ') || bodyWithoutImports.includes('@' + dec + '\n');
    if (uses && !imported.has(dec)) {
      issues.push(`${file}: uses @${dec}() but the @nestjs/common import lacks it`);
    }
  }

  // this.X where X is not a declared field/local: collect declared names.
  const declared = new Set();
  const ctor = src.match(/constructor\s*\(([\s\S]*?)\)\s*\{/);
  if (ctor) {
    for (const param of ctor[1].split(',')) {
      const m = param.match(/(\w+)\s*:\s*[\w.]+/);
      if (m) declared.add(m[1]);
      const pm = param.match(/(?:private|protected|public)?\s*(?:readonly\s+)?(\w+)\s*[=:]/);
      if (pm) declared.add(pm[1]);
    }
  }
  for (const stmt of src.matchAll(/(?:private|protected|public|const|let|var)\s+(?:readonly\s+)?(\w+)/g)) {
    declared.add(stmt[1]);
  }
  for (const fn of src.matchAll(/(?:function\s+(\w+)|(\w+)\s*\()/g)) {
    if (fn[1]) declared.add(fn[1]);
  }
  const thisUses = new Set([...bodyWithoutImports.matchAll(/this\.(\w+)/g)].map((m) => m[1]));
  for (const name of thisUses) {
    if (!declared.has(name) && !name.startsWith('_')) {
      // heuristics: methods are declared on the class
      const isMethod = new RegExp(`(?:async\\s+)?${name}\\s*\\(`).test(bodyWithoutImports);
      if (!isMethod) {
        issues.push(`${file}: this.${name} used but never declared`);
      }
    }
  }
}
console.log(issues.length ? issues.join('\n') : 'no issues found');
