import {test} from 'node:test';import assert from 'node:assert/strict';import {previewDocument,validPreviewStorage} from '../src/preview.js';
test('preview bootstrap escapes project data and accepts only bounded string storage',()=>{
 const html=previewDocument('<div id="root"></div>','token',{text:'</script><script>attack()</script>'});assert(!html.includes('<script>attack()'));assert(html.includes('\\u003c/script>'));assert(validPreviewStorage({polls:'[]'}));assert(!validPreviewStorage({nested:{}}));assert(!validPreviewStorage({x:'x'.repeat(262145)}));
});
