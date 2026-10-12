import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import * as vue from 'vue';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { parse, compileScript } = require('@vue/compiler-sfc');
const { descriptor } = parse(readFileSync(new URL('../src/ui/SlSlider.vue', import.meta.url), 'utf8'));
const { outputText } = ts.transpileModule(compileScript(descriptor, { id: 'slider-drag' }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

function fixture(overrides = {}) {
  const unmounts = [];
  const exports = {};
  new Function('require', 'exports', outputText)(() => ({
    ...vue, useAttrs: () => ({}), onUnmounted: fn => unmounts.push(fn),
  }), exports);
  const props = vue.reactive({ modelValue: 20, min: 0, max: 100, step: 1, disabled: false, orientation: 'vertical', ...overrides });
  const events = [];
  const slider = exports.default.setup(props, {
    expose() {}, emit: (name, value) => {
      events.push([name, value]);
      if (name === 'update:modelValue') props.modelValue = value;
    },
  });
  const captured = new Set();
  slider.shell.value = {
    setPointerCapture: id => captured.add(id),
    hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
  };
  slider.track.value = { getBoundingClientRect: () => ({ top: 100, height: 100 }) };
  slider.input.value = { focus() {} };
  const pointer = (clientY, pointerId = 7, button = 0) => ({ clientY, pointerId, button, preventDefault() {} });
  return { slider, props, events, captured, pointer, unmount: () => unmounts.forEach(fn => fn()) };
}

test('vertical drag follows Y, keeps capture outside the track and commits once on release', () => {
  const f = fixture();
  f.slider.onPointerDown(f.pointer(180));
  f.slider.onPointerMove(f.pointer(130));
  assert.equal(f.props.modelValue, 70);
  assert.equal(f.events.filter(([name]) => name === 'change').length, 0);
  assert.ok(f.captured.has(7));
  f.slider.onPointerUp(f.pointer(125));
  assert.equal(f.props.modelValue, 75);
  assert.deepEqual(f.events.filter(([name]) => name === 'change'), [['change', 75]]);
  assert.equal(f.captured.size, 0);
  f.slider.cancelPointer(f.pointer(125));
  f.slider.onPointerUp(f.pointer(125));
  assert.equal(f.events.filter(([name]) => name === 'change').length, 1);
});

test('secondary pointers and mouse buttons cannot interrupt an active drag', () => {
  const f = fixture();
  f.slider.onPointerDown(f.pointer(180, 7, 2));
  assert.equal(f.events.length, 0);
  f.slider.onPointerDown(f.pointer(180));
  f.slider.onPointerDown(f.pointer(110, 8));
  f.slider.onPointerMove(f.pointer(110, 8));
  f.slider.cancelPointer(f.pointer(110, 8));
  assert.equal(f.props.modelValue, 20);
  assert.ok(f.captured.has(7));
  f.slider.onPointerUp(f.pointer(150));
  assert.deepEqual(f.events.filter(([name]) => name === 'change'), [['change', 50]]);
});

test('out-of-track dragging clamps volume at both ends', () => {
  const f = fixture();
  f.slider.onPointerDown(f.pointer(250));
  assert.equal(f.props.modelValue, 0);
  f.slider.onPointerMove(f.pointer(50));
  assert.equal(f.props.modelValue, 100);
  f.slider.onPointerUp(f.pointer(50));
  assert.deepEqual(f.events.filter(([name]) => name === 'change'), [['change', 100]]);
});

test('cancel, disable and unmount release capture without sending a volume command', async () => {
  for (const action of ['cancel', 'disable', 'unmount']) {
    const f = fixture();
    f.slider.onPointerDown(f.pointer(130));
    if (action === 'cancel') f.slider.cancelPointer(f.pointer(130));
    if (action === 'disable') { f.props.disabled = true; await vue.nextTick(); }
    if (action === 'unmount') f.unmount();
    f.slider.onPointerUp(f.pointer(120));
    assert.equal(f.captured.size, 0, action);
    assert.deepEqual(f.events.filter(([name]) => name === 'change'), [], action);
    assert.deepEqual(f.events.filter(([name]) => name === 'dragging'), [['dragging', true], ['dragging', false]], action);
  }
});

test('horizontal and disabled sliders keep native input handling', () => {
  for (const props of [{ orientation: 'horizontal' }, { disabled: true }]) {
    const f = fixture(props);
    f.slider.onPointerDown(f.pointer(130));
    assert.equal(f.events.length, 0);
  }
});
