import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { reactive, watch } from 'vue';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const { outputText } = ts.transpileModule(readFileSync(new URL('../src/runtime.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
});

function fixture(width = 375) {
  const document = new EventTarget();
  document.documentElement = { scrollTop: 0 };
  document.body = { scrollTop: 0 };
  const state = reactive({ confirm: { open: false } });
  const messages = [];
  const window = new EventTarget();
  window.innerWidth = width;
  window.parent = window;
  window.postMessage = data => messages.push(typeof data === 'string' ? JSON.parse(data) : data);
  const exports = {};
  new Function('require', 'exports', 'document', 'window', outputText)(name => {
    if (name === 'vue') return { reactive, watch };
    if (name === './store') return { state, resolveConfirm: () => { state.confirm.open = false; } };
    throw new Error(`unexpected dependency: ${name}`);
  }, exports, document, window);
  const dispose = exports.installHostBack();
  return {
    ...exports, state, dispose, document, window, messages,
    back: () => !document.dispatchEvent(new Event('songloft-back', { cancelable: true })),
  };
}

test('host back closes overlays, then lyrics, then full player without leaving the plugin', () => {
  const f = fixture();
  f.openPage('player');
  f.navigation.playerPage = 1;
  f.navigation.playerPopup = 'full-volume';
  f.state.confirm.open = true;
  assert.equal(f.back(), true);
  assert.equal(f.state.confirm.open, false);
  assert.equal(f.navigation.playerPopup, 'full-volume');
  assert.equal(f.back(), true);
  assert.equal(f.navigation.playerPopup, '');
  assert.equal(f.navigation.playerPage, 1);
  assert.equal(f.back(), true);
  assert.equal(f.navigation.playerPage, 0);
  assert.equal(f.navigation.page, 'player');
  assert.equal(f.back(), true);
  assert.equal(f.navigation.page, 'main');
  assert.equal(f.back(), false);
});

test('reopening the player starts on the cover; desktop back closes the player directly', () => {
  const f = fixture(1280);
  f.openPage('player');
  f.navigation.playerPage = 1;
  assert.equal(f.back(), true);
  assert.equal(f.navigation.page, 'main');
  f.openPage('player');
  assert.equal(f.navigation.playerPage, 0);
});

test('existing device picker, editor and settings back order is preserved', () => {
  const f = fixture();
  f.openPage('settings');
  f.navigation.settingsCategory = 'voice';
  f.navigation.editorOpen = true;
  f.navigation.devicePickerOpen = true;
  assert.equal(f.back(), true);
  assert.equal(f.navigation.devicePickerOpen, false);
  assert.equal(f.navigation.editorOpen, true);
  assert.equal(f.back(), true);
  assert.equal(f.navigation.editorOpen, false);
  assert.equal(f.back(), true);
  assert.equal(f.navigation.settingsCategory, '');
  assert.equal(f.navigation.page, 'settings');
  assert.equal(f.back(), true);
  assert.equal(f.navigation.page, 'main');
});

test('unmounted app no longer consumes host back', () => {
  const f = fixture();
  f.openPage('player');
  f.dispose();
  assert.equal(f.back(), false);
  assert.equal(f.navigation.page, 'player');
});

function detailEvent(type, detail) {
  const event = new Event(type);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

test('native connection reports live back state and returns a correlated result', () => {
  const f = fixture();
  f.document.dispatchEvent(detailEvent('songloft-back-connect', { session: 'native-1' }));
  assert.deepEqual(f.messages.at(-1), { type: 'songloft-back-state', session: 'native-1', canBack: false });
  f.openPage('player');
  assert.equal(f.messages.at(-1).canBack, true);
  f.navigation.playerPage = 1;
  f.document.dispatchEvent(detailEvent('songloft-back-request', { session: 'native-1', id: 1 }));
  assert.equal(f.navigation.playerPage, 0);
  assert.deepEqual(f.messages.at(-1), { type: 'songloft-back-result', session: 'native-1', id: 1, consumed: true, canBack: true });
  f.document.dispatchEvent(detailEvent('songloft-back-request', { session: 'native-1', id: 2 }));
  assert.equal(f.navigation.page, 'main');
  assert.equal(f.messages.at(-1).canBack, false);
  f.document.dispatchEvent(detailEvent('songloft-back-request', { session: 'native-1', id: 3 }));
  assert.equal(f.messages.at(-1).consumed, false);
  f.dispose();
});

test('cross-origin iframe accepts only the parent and replies to its origin', () => {
  const f = fixture();
  const replies = [];
  const parent = { postMessage: (data, origin) => replies.push({ data, origin }) };
  f.window.parent = parent;
  const message = (data, source = parent, origin = 'https://client.example') => {
    const event = new Event('message');
    Object.defineProperties(event, { data: { value: data }, source: { value: source }, origin: { value: origin } });
    f.window.dispatchEvent(event);
  };
  message({ type: 'songloft-back-connect', session: 'web-1' }, {});
  assert.equal(replies.length, 0);
  message({ type: 'songloft-back-connect', session: 'web-1' });
  f.openPage('player');
  assert.equal(replies.at(-1).data.canBack, true);
  message({ type: 'songloft-back-request', session: 'stale', id: 1 });
  message({ type: 'songloft-back-request', session: 'web-1', id: 1 }, parent, 'https://other.example');
  message({ type: 'songloft-back-request', session: 'web-1', id: 1 }, {});
  assert.equal(f.navigation.page, 'player');
  message({ type: 'songloft-back-request', session: 'web-1', id: 2 });
  assert.equal(f.navigation.page, 'main');
  assert.deepEqual(replies.at(-1), {
    data: { type: 'songloft-back-result', session: 'web-1', id: 2, consumed: true, canBack: false },
    origin: 'https://client.example',
  });
  f.dispose();
  const count = replies.length;
  f.openPage('player');
  message({ type: 'songloft-back-request', session: 'web-1', id: 3 });
  assert.equal(f.navigation.page, 'player');
  assert.equal(replies.length, count);
});
