require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');
  const events = req.body.events || [];
  for (const event of events) {
    if (event.source && event.source.type === 'group') {
      const groupId = event.source.groupId;
      console.log('\n✅ グループIDを検出しました！\n');
      console.log('LINE_GROUP_ID_REMINDER=' + groupId);
      console.log('\n.envとGitHub Secretsに登録してください。\n');
    }
  }
});

app.listen(3000, () => {
  console.log('========================================');
  console.log('LINEグループID 取得ツール');
  console.log('========================================');
  console.log('手順:');
  console.log('1. AI秘書のLINEチャンネルをグループに招待');
  console.log('2. グループ内で何かメッセージを送る');
  console.log('3. グループIDが自動表示されます');
  console.log('ポート3000でWebhookを待機中...');
  console.log('========================================');
});

