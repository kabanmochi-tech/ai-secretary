/**
 * invoice_reminder.js
 * 毎月第2金曜日と第3木曜日にLINEグループへリマインドを送信する。
 *
 * GitHub Actionsから毎日実行され、
 * 第2金曜・第3木曜のみ送信（それ以外は何もしない）。
 *
 * 実行: node src/invoice_reminder.js
 * テスト: node src/invoice_reminder.js --test-friday   （第2金曜メッセージを強制送信）
 *         node src/invoice_reminder.js --test-thursday （第3木曜メッセージを強制送信）
 */
require('dotenv').config();
const { LineClient } = require('./line');

const GROUP_ID      = process.env.LINE_GROUP_ID_REMINDER;
const SENDER_NAME   = process.env.REMINDER_SENDER_NAME   || '担当者';
const CONTACT_INFO  = process.env.REMINDER_CONTACT_INFO  || '';
const TARGET_GROUP  = process.env.REMINDER_TARGET_GROUP  || '皆さま';
const DOCUMENT_NAME = process.env.REMINDER_DOCUMENT_NAME || '書類';
const DEADLINE_DESC = process.env.REMINDER_DEADLINE_DESC || '各月第三金曜日';

// 連絡先がある場合のみ「〇〇まで」を追加、ない場合はシンプルに
const contactLine = CONTACT_INFO
  ? `${CONTACT_INFO}\nまで送付をお願いできますでしょうか。`
  : '送付をお願いできますでしょうか。';

const MESSAGE_SECOND_FRIDAY = `${TARGET_GROUP}
お世話になります。${SENDER_NAME}です。
${DOCUMENT_NAME}について今月分取りまとめたくリマインドのご連絡失礼致します。
${contactLine}
期限は${DEADLINE_DESC}となっております。
締め切り前日にもう一度リマインドいたします。
どうぞよろしくお願いします。`;

const MESSAGE_THIRD_THURSDAY = `${TARGET_GROUP}
お世話になります。${SENDER_NAME}です。
${DOCUMENT_NAME}について今月分取りまとめたくリマインドのご連絡失礼致します。
${contactLine}
期限は明日となっております。
どうぞよろしくお願いします。`;

/**
 * 第何週かを返す（1始まり）
 * @param {Date} date
 * @returns {number}
 */
function getWeekOfMonth(date) {
  return Math.ceil(date.getDate() / 7);
}

/**
 * 現在時刻をJSTで返す
 * GitHub ActionsはUTCで動くため +9時間オフセットを加算する
 * @returns {Date}
 */
function getJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

/**
 * LINEグループにメッセージを送信する
 * @param {string} message
 * @param {string} label  ログ用ラベル
 */
async function sendToGroup(message, label) {
  if (!GROUP_ID) {
    console.error('❌ LINE_GROUP_ID_REMINDER が未設定です。tools/get_group_id.js を実行してください');
    process.exit(1);
  }

  const lineClient = new LineClient();
  try {
    await lineClient.pushToGroup(GROUP_ID, message);
    console.log(`✅ 送信完了: ${label}`);
  } catch (error) {
    console.error(`❌ 送信失敗: ${label} - ${error.message}`);
  }
}

async function main() {
  const args = process.argv;
  const jst  = getJST();
  const dow  = jst.getDay();
  const week = getWeekOfMonth(jst);

  console.log(`実行日時(JST): ${jst.toLocaleString('ja-JP')}`);
  console.log(`曜日: ${dow} / 第${week}週`);

  if (args.includes('--test-friday')) {
    console.log('🧪 テスト: 第2金曜メッセージを強制送信');
    await sendToGroup(MESSAGE_SECOND_FRIDAY, '第2金曜リマインド');
    return;
  }
  if (args.includes('--test-thursday')) {
    console.log('🧪 テスト: 第3木曜メッセージを強制送信');
    await sendToGroup(MESSAGE_THIRD_THURSDAY, '第3木曜リマインド');
    return;
  }

  if (dow === 5 && week === 2) {
    console.log('📅 第2金曜です。リマインド（1回目）を送信します');
    await sendToGroup(MESSAGE_SECOND_FRIDAY, '第2金曜リマインド');
    return;
  }

  if (dow === 4 && week === 3) {
    console.log('📅 第3木曜です。リマインド（2回目）を送信します');
    await sendToGroup(MESSAGE_THIRD_THURSDAY, '第3木曜リマインド');
    return;
  }

  console.log('送信対象日ではないため終了します');
}

main().catch(console.error);
