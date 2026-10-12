import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const ts = require('typescript');
export function loader(overrides = {}) {
  const cache = new Map();
  function load(file) {
    const path = resolve(dirname(fileURLToPath(import.meta.url)), file);
    if (cache.has(path))
      return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    const source = readFileSync(path, 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
    new Function('require', 'exports', outputText)(name => {
      if (Object.hasOwn(overrides, name))
        return overrides[name];
      if (name === '@songloft/plugin-sdk')
        return load('../../../toolchain/packages/plugin-sdk/src/index.ts');
      if (!name.startsWith('.'))
        return require(name);
      const base = resolve(dirname(path), name);
      if (base.endsWith('.json'))
        return JSON.parse(readFileSync(base, 'utf8'));
      const target = existsSync(`${base}.ts`) ? `${base}.ts` : resolve(base, 'index.ts');
      return load(target);
    }, exports);
    return exports;
  }
  return load;
}
export async function flush() {
  for (let i = 0; i < 80; i++)
    await Promise.resolve();
}
export function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { resolve, reject, promise }; }
