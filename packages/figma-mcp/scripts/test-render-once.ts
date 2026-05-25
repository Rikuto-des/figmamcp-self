import { renderNode } from '../src/render.js';
import { writeFileSync } from 'fs';

async function main() {
  console.log('rendering...');
  const result = await renderNode({ fileKey: 'lLZvKG0OgoWcFHFVUp4IJl', nodeId: '81:666', scale: 2 });
  console.log('size:', result.width, 'x', result.height, '| bytes:', result.bytes.length);
  writeFileSync('../../tmp-test.png', result.bytes);
  console.log('✅ saved');
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
