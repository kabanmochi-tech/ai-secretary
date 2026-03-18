require('dotenv').config();
const { LineClient } = require('../src/line');

async function main() {
  const lineClient = new LineClient();
  try {
    await lineClient.pushMessage('✅ AI秘書の接続テストです。正常に動作しています。');
    console.log('✅ LINEへの送信に成功しました');
  } catch (err) {
    console.error('❌ LINE送信に失敗しました:', err.message);
    process.exit(1);
  }
}

main();
