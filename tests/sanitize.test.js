'use strict';
const assert = require('assert');
const { sanitizeSegment, sanitizeDownloadPath } = require('../shared/filename.js');

const cases = [
  ['Video 5/001_scene_1.png',        'Video 5/001_scene_1.png'],
  ['Video 5./001_a.png',             'Video 5/001_a.png'],      // trailing dot
  ['My Folder /001_a.png',           'My Folder/001_a.png'],    // trailing space
  ['../../evil/001_a.png',           'evil/001_a.png'],         // traversal
  ['/abs\\path/a.png',               'abs/path/a.png'],         // absolute + backslash
  ['a:b*c?/x.png',                   'a_b_c_/x.png'],           // reserved chars
  ['con/x.png',                      '_con/x.png'],             // reserved device name
  ['',                               ''],
  ['...',                            ''],
];

for (const [input, expected] of cases) {
  assert.strictEqual(sanitizeDownloadPath(input), expected, `input: ${JSON.stringify(input)}`);
}
assert.strictEqual(sanitizeSegment('ok name'), 'ok name');
assert.ok(sanitizeDownloadPath('x/'.repeat(300)).length <= 200);

console.log(`sanitize: ${cases.length + 2} checks passed`);
