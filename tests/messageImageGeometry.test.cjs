const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const geometryPath = path.resolve(
  __dirname,
  '../src/components/chat/messageImageGeometry.ts',
);
const transpiled = ts.transpileModule(fs.readFileSync(geometryPath, 'utf8'), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
  },
  fileName: geometryPath,
}).outputText;
const geometryModule = { exports: {} };
vm.runInNewContext(transpiled, {
  exports: geometryModule.exports,
  module: geometryModule,
}, { filename: geometryPath });

const {
  calculateMessageImageGeometry,
  MESSAGE_IMAGE_FALLBACK_HEIGHT,
  MESSAGE_IMAGE_FALLBACK_WIDTH,
} = geometryModule.exports;

function assertGeometry(actual, expected) {
  assert.deepEqual(
    { width: actual.width, height: actual.height },
    expected,
  );
}

test('uses the deterministic fallback when either metadata dimension is missing', () => {
  assertGeometry(
    calculateMessageImageGeometry(undefined, 900, 390),
    {
      width: MESSAGE_IMAGE_FALLBACK_WIDTH,
      height: MESSAGE_IMAGE_FALLBACK_HEIGHT,
    },
  );
  assertGeometry(
    calculateMessageImageGeometry(1600, undefined, 390),
    {
      width: MESSAGE_IMAGE_FALLBACK_WIDTH,
      height: MESSAGE_IMAGE_FALLBACK_HEIGHT,
    },
  );
});

test('constrains a landscape image by the maximum message-image width', () => {
  assertGeometry(calculateMessageImageGeometry(1600, 900, 390), {
    width: 280,
    height: 158,
  });
});

test('constrains a portrait image by the maximum message-image height', () => {
  assertGeometry(calculateMessageImageGeometry(1080, 1920, 390), {
    width: 180,
    height: 320,
  });
});

test('fits the reserved box within a narrow phone viewport', () => {
  assertGeometry(calculateMessageImageGeometry(1000, 500, 320), {
    width: 232,
    height: 116,
  });
  assertGeometry(calculateMessageImageGeometry(undefined, undefined, 320), {
    width: 232,
    height: 174,
  });
});

test('does not upscale valid small images', () => {
  assertGeometry(calculateMessageImageGeometry(100, 50, 390), {
    width: 100,
    height: 50,
  });
});

test('accepts numeric metadata strings and rejects invalid dimensions', () => {
  assertGeometry(calculateMessageImageGeometry('1600', '900', 390), {
    width: 280,
    height: 158,
  });
  assertGeometry(calculateMessageImageGeometry(-1, Number.NaN, 390), {
    width: MESSAGE_IMAGE_FALLBACK_WIDTH,
    height: MESSAGE_IMAGE_FALLBACK_HEIGHT,
  });
});
