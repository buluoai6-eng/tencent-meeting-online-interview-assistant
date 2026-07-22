const assert = require('assert');
const { app, safeStorage } = require('electron');

app.whenReady().then(() => {
  assert.strictEqual(safeStorage.isEncryptionAvailable(), true, '系统安全存储不可用');
  const example = 'sk-test-placeholder-not-a-real-key';
  const encrypted = safeStorage.encryptString(example);
  assert.ok(Buffer.isBuffer(encrypted));
  assert.notStrictEqual(encrypted.toString('utf8'), example);
  assert.strictEqual(safeStorage.decryptString(encrypted), example);
  console.log('safeStorage encryption smoke test passed');
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
