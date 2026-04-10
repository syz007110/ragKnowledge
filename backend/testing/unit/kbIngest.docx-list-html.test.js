const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Regression helper: docx-style HTML list shape (Word/mammoth-like export patterns).
 */
function extractDocxLikeBlocks(html) {
  const blocks = [];
  const blockRegex = /<(h[1-6]|p|li|table)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = blockRegex.exec(html))) {
    const tag = String(match[1] || '').toLowerCase();
    const inner = String(match[2] || '');
    if (tag === 'table') continue;
    const text = String(inner || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (/^h[1-6]$/.test(tag)) {
      blocks.push({ type: 'heading', text });
    } else {
      blocks.push({ type: 'paragraph', text });
    }
  }
  return blocks;
}

test('docx html block regex includes ul/li list items', () => {
  const html = '<p>异常处理：</p><ul><li>医生控制台提示</li><li>仿真画面中无法看到器械</li></ul>';
  const blocks = extractDocxLikeBlocks(html);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, '异常处理：');
  assert.match(blocks[1].text, /医生控制台提示/);
  assert.match(blocks[2].text, /仿真画面/);
});
