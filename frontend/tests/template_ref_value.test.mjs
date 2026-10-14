import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// <script setup> 模板里的 ref 自动解包：模板写 x.value 会被编译成 x.value.value，
// 运行时取到 undefined（曾在添加记忆按钮上炸过：content 变 undefined → 后端 400 chat_request_failed）。
// 这里静态兜底：script setup 里用 ref()/shallowRef() 声明的名字，模板里再写 .value 即失败。

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function vueFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...vueFiles(full));
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

test('模板段禁止对 script setup 的 ref 写 .value（自动解包下会变成 .value.value）', () => {
  const violations = [];
  for (const file of vueFiles(sourceRoot)) {
    const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const script = source.match(/<script setup[^>]*>([\s\S]*?)<\/script>/);
    const template = source.match(/<template[^>]*>([\s\S]*)<\/template>/);
    if (!script || !template) continue;
    const refs = new Set();
    for (const match of script[1].matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:ref|shallowRef)\s*\(/g))
      refs.add(match[1]);
    if (!refs.size) continue;
    const forScoped = new Set([...template[1].matchAll(/v-for="\(?\s*([\w$]+)/g)].map(m => m[1]));
    const templateLine = source.slice(0, template.index).split('\n').length;
    for (const name of refs) {
      if (forScoped.has(name)) continue;
      const pattern = new RegExp('\\b' + name + '\\.value\\b');
      template[1].split('\n').forEach((line, i) => {
        if (pattern.test(line))
          violations.push(`${path.relative(sourceRoot, file)}:${templateLine + i}: 模板对 ref ${name} 使用了 .value`);
      });
    }
  }
  assert.deepEqual(violations, [], violations.join('\n'));
});
