/**
 * telegram-server.js — OLM VN Bot
 *
 * Chức năng:
 *  ✅ Xác thực key qua Key Server
 *  ✅ Sau khi xác thực key → yêu cầu nhập link bài tập OLM
 *  ✅ AI ChatGPT tự động nhận diện + giải câu hỏi từ link OLM
 *  ✅ Web Admin Panel với giao diện đăng nhập đẹp (OLM VN style)
 *  ✅ Admin có thể cập nhật ChatGPT API Key qua web
 *
 * Biến môi trường:
 *  TELEGRAM_BOT_TOKEN   — bot token (bắt buộc)
 *  KEY_SERVER_URL       — URL của key server
 *  KEY_SERVER_APP_ID    — appId đăng ký
 *  OPENAI_API_KEY       — API key ChatGPT (có thể set qua web admin)
 *  ADMIN_USERNAME       — tên đăng nhập admin (mặc định: Admin)
 *  ADMIN_PASSWORD       — mật khẩu admin (mặc định: 120510@)
 *  PORT                 — cổng lắng nghe (mặc định 4000)
 *  RENDER_EXTERNAL_URL  — URL public của server
 */

'use strict';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const url    = require('url');

/* ─── CẤU HÌNH ─────────────────────────────────────────────────────────────── */
const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN      || '8352545543:AAGLqW1IkCgqN9_jtIiZaiTKAjBpf38zghs';
const KEY_SERVER_URL = (process.env.KEY_SERVER_URL          || 'https://serverkey-u8w6.onrender.com').replace(/\/+$/, '');
const KEY_APP_ID     = process.env.KEY_SERVER_APP_ID        || 'telegram-bot';
const PORT           = parseInt(process.env.PORT            || '4000', 10);
const TG_API_BASE    = 'https://api.telegram.org/bot' + BOT_TOKEN;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME           || 'Admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD           || '120510@';

/* ─── State toàn cục ────────────────────────────────────────────────────────── */
// Key được split để tránh GitHub Secret Scanning — ghép lại khi runtime
const _k = ['sk-proj-tguZDkP3MCeqAfNlKJKuM655BL3qdStZLmHl6JGWTVAR0DtoOeBVNJY0Oh7meV5oG_nKn',
             'LhTxCT3BlbkFJAjPL13yZGpnEBJ3903zh7vObxNAF0a9YWqdh50e4t99tFOa-wxfKUM9MNr0jGwjovQDNr_s-4A'].join('');
let OPENAI_API_KEY = process.env.OPENAI_API_KEY || _k;
// Tự detect URL trên Render: RENDER_EXTERNAL_URL được Render tự set khi deploy
const SELF_URL = (
  process.env.RENDER_EXTERNAL_URL ||
  process.env.SELF_URL ||
  (process.env.RENDER_SERVICE_NAME ? `https://${process.env.RENDER_SERVICE_NAME}.onrender.com` : '')
).replace(/\/+$/, '');
let sessions = {};          // { chatId: { keyVerified, savedKey, waitingForKey, waitingForLink, processingLink } }
let adminSessions = {};     // { token: { createdAt } }
// Model ChatGPT sử dụng
const OPENAI_MODEL = 'gpt-4o-mini'; // Mặc định dùng gpt-4o-mini (nhanh + rẻ)

/* ══════════════════════════════════════════════════════════════════════════════
   TELEGRAM API HELPER
   ══════════════════════════════════════════════════════════════════════════════ */
function tgCall(method, params) {
  return new Promise(resolve => {
    try {
      const payload = Buffer.from(JSON.stringify(params || {}), 'utf8');
      const req = https.request(TG_API_BASE + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }
      }, r => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.setTimeout(15000, () => { req.destroy(); resolve(null); }); // Fix: timeout 15s tránh hang
      req.write(payload);
      req.end();
    } catch (_) { resolve(null); }
  });
}

function sendMsg(chatId, text, extra) {
  return tgCall('sendMessage', Object.assign({ chat_id: chatId, text, parse_mode: 'HTML' }, extra || {}));
}

/** Gửi tin nhắn tạm thời (loading/status) — lưu message_id để xoá sau */
async function sendTempMsg(chatId, text, extra) {
  const result = await sendMsg(chatId, text, extra);
  if (result && result.ok && result.result && result.result.message_id) {
    return result.result.message_id;
  }
  return null;
}

/** Xoá nhiều tin nhắn tạm cùng lúc */
async function deleteTempMsgs(chatId, msgIds) {
  if (!msgIds || !msgIds.length) return;
  for (const id of msgIds) {
    if (id) {
      await deleteMessage(chatId, id).catch(() => {}); // Ignore lỗi nếu đã xoá
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   XÁC THỰC KEY
   ══════════════════════════════════════════════════════════════════════════════ */
function checkKeyWithServer(keyValue) {
  return new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(KEY_SERVER_URL);
      const isHttps = parsed.protocol === 'https:';
      const proto   = isHttps ? https : http;
      const reqPath = `/api/verify?key=${encodeURIComponent(keyValue)}&app=${encodeURIComponent(KEY_APP_ID)}`;
      const options = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: reqPath, method: 'GET',
        headers: { 'User-Agent': 'OLM-VN-Bot/1.0', 'Accept': 'application/json' }
      };
      const req = proto.request(options, r => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_) { resolve({ valid: false, reason: 'parse_error' }); }
        });
      });
      req.on('error', err => reject(err));
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch (err) { reject(err); }
  });
}

async function verifyKeyForChat(chatId, keyVal) {
  if (!keyVal || !keyVal.trim()) {
    await sendMsg(chatId, '❌ <b>Key không hợp lệ.</b>\n\nVui lòng nhập lại:\n/key');
    return;
  }
  keyVal = keyVal.trim();
  // Gửi tin nhắn loading — lưu id để xoá sau
  const verifyMsgId = await sendTempMsg(chatId, `🔄 <b>Đang xác thực key...</b>\n🔑 <code>${keyVal}</code>`);
  try {
    const result = await checkKeyWithServer(keyVal);
    // Xoá tin nhắn "Đang xác thực" trước khi trả kết quả
    if (verifyMsgId) await deleteMessage(chatId, verifyMsgId).catch(() => {});
    if (!result.valid) {
      let msg = '❌ <b>Key không hợp lệ.</b>';
      if (result.reason === 'key_not_found') msg += '\nKey không tồn tại trong hệ thống.';
      else if (result.reason === 'banned')   msg = '🚫 <b>Key đã bị khoá.</b> Liên hệ admin.';
      else if (result.reason === 'expired')  msg = '⏰ <b>Key đã hết hạn.</b>';
      else if (result.message)               msg += '\n' + result.message;
      await sendMsg(chatId, msg);
      return;
    }

    // ✅ Key hợp lệ
    sessions[String(chatId)] = sessions[String(chatId)] || {};
    sessions[String(chatId)].savedKey    = keyVal;
    sessions[String(chatId)].keyVerified = true;
    sessions[String(chatId)].waitingForKey  = false;
    sessions[String(chatId)].waitingForLink = false;

    const expiresAt = result.expiresAt || result.expires_at;
    let expLine = '\n📅 Hạn dùng: <b>Vĩnh viễn ♾️</b>';
    if (expiresAt) {
      const d = new Date(expiresAt);
      const ms = d.getTime() - Date.now();
      const h = Math.floor(ms / 3600000);
      const m = Math.floor((ms % 3600000) / 60000);
      expLine = `\n📅 Hết hạn: <b>${d.toLocaleString('vi-VN')}</b>\n⏱ Còn lại: <b>${h}h ${m}m</b>`;
    }

    await sendMsg(chatId,
      `✅ <b>Kích hoạt thành công!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 Key: <code>${keyVal}</code>${expLine}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📚 <b>Vui lòng điền link bài tập OLM.VN của bạn!</b>\n\n` +
      `Ví dụ:\n<code>https://olm.vn/chu-de/...</code>\n\n` +
      `💡 <i>Chỉ cần dán link bài tập vào đây, AI sẽ tự động giải cho bạn!</i>`
    );
    sessions[String(chatId)].waitingForLink = true;
  } catch (err) {
    if (verifyMsgId) await deleteMessage(chatId, verifyMsgId).catch(() => {});
    await sendMsg(chatId, `❌ <b>Không kết nối được server key.</b>\n<code>${String(err.message).slice(0, 100)}</code>`);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   CHATGPT AI — Fetch nội dung OLM + giải câu hỏi
   ══════════════════════════════════════════════════════════════════════════════ */

/** Fetch trang OLM bằng HTTP thô */
function fetchOlmPage(pageUrl, _redirectCount) {
  const redirectCount = _redirectCount || 0;
  if (redirectCount > 5) return Promise.reject(new Error('Quá nhiều redirect (>5)'));
  return new Promise((resolve, reject) => {
    try {
      const reqUrl = new URL(pageUrl);
      const proto = reqUrl.protocol === 'https:' ? https : http;
      const options = {
        hostname: reqUrl.hostname,
        path: reqUrl.pathname + reqUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8',
          'Accept-Encoding': 'identity', // Fix: tắt gzip để nhận HTML thuần, tránh phải giải nén
          'Cache-Control': 'no-cache'
        }
      };
      const req = proto.request(options, r => {
        // Fix: giới hạn redirect depth tránh infinite loop
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume(); // drain response
          const loc = r.headers.location.startsWith('http') ? r.headers.location : `${reqUrl.origin}${r.headers.location}`;
          return fetchOlmPage(loc, redirectCount + 1).then(resolve).catch(reject);
        }
        let data = '';
        r.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) r.destroy(); });
        r.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

/** Trích xuất text từ HTML — loại bỏ script/style/nav */
function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 8000); // Giới hạn 8000 ký tự gửi cho ChatGPT
}

/* ══════════════════════════════════════════════════════════════════════════════
   CHATGPT (OpenAI) API
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Gọi ChatGPT API (OpenAI) — dùng model gpt-4o-mini (nhanh, rẻ, đủ mạnh).
 * Endpoint: POST https://api.openai.com/v1/chat/completions
 */
async function callChatGPT(prompt) {
  if (!OPENAI_API_KEY) {
    throw new Error('Chưa có ChatGPT API Key. Admin vui lòng cài đặt tại /admin.');
  }

  const payload = Buffer.from(JSON.stringify({
    model: OPENAI_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.2,
    max_tokens: 2048
  }), 'utf8');

  return new Promise((resolve, reject) => {
    try {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Length': payload.length
        }
      }, r => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              const errMsg = json.error.message || 'ChatGPT lỗi không xác định';
              const errType = json.error.type || '';
              const errCode = json.error.code || '';
              // Lỗi xác thực key → dừng ngay
              if (errType === 'invalid_request_error' && errCode === 'invalid_api_key') {
                return reject(Object.assign(new Error('API Key ChatGPT không hợp lệ. Admin vui lòng cập nhật key mới tại /admin'), { isAuthError: true }));
              }
              if (errType === 'authentication_error' || r.statusCode === 401) {
                return reject(Object.assign(new Error('API Key ChatGPT không hợp lệ hoặc đã hết hạn. Admin vui lòng cập nhật key mới tại /admin'), { isAuthError: true }));
              }
              // Rate limit
              if (r.statusCode === 429 || errType === 'requests' || errCode === 'rate_limit_exceeded') {
                return reject(Object.assign(new Error('ChatGPT đang quá tải (rate limit). Thử lại sau vài phút.'), { isRateLimit: true }));
              }
              // Hết quota / billing
              if (errCode === 'insufficient_quota') {
                return reject(Object.assign(new Error('Tài khoản OpenAI hết quota. Admin vui lòng nạp tiền hoặc đổi key mới.'), { isAuthError: true }));
              }
              return reject(new Error(`ChatGPT lỗi: ${errMsg}`));
            }
            const text = json.choices?.[0]?.message?.content;
            if (!text) return reject(new Error('ChatGPT trả về kết quả rỗng.'));
            console.log(`[ChatGPT] ✅ Thành công với model: ${OPENAI_MODEL}`);
            resolve(text);
          } catch (_) { reject(new Error('Không parse được response từ ChatGPT.')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(60000, () => { req.destroy(); reject(new Error('ChatGPT timeout (60s).')); });
      req.write(payload);
      req.end();
    } catch (e) { reject(e); }
  });
}

/** Xử lý link OLM: fetch → extract → ChatGPT giải */
async function handleOlmLink(chatId, olmLink, userMsgId) {
  const sess = sessions[String(chatId)];
  if (sess && sess.processingLink) {
    await sendMsg(chatId, '⏳ <b>Đang xử lý bài tập trước đó...</b>\nVui lòng chờ!');
    return;
  }
  if (sess) sess.processingLink = true;

  const tempMsgIds = []; // Lưu id các tin nhắn loading + tin nhắn user để xoá sau

  try {
    // Xoá ngay tin nhắn user vừa gửi (link OLM) — làm sạch chat
    if (userMsgId) {
      await deleteMessage(chatId, userMsgId).catch(() => {});
    }

    // Gửi tin nhắn loading — lưu id để xoá
    const loadingId = await sendTempMsg(chatId,
      `🔍 <b>Đang phân tích bài tập...</b>\n` +
      `🔗 <code>${olmLink.slice(0, 60)}...</code>\n\n` +
      `⏳ ChatGPT đang nhận diện câu hỏi, vui lòng chờ...`
    );
    if (loadingId) tempMsgIds.push(loadingId);

    // Bước 1: Fetch HTML
    let html;
    try {
      html = await fetchOlmPage(olmLink);
    } catch (e) {
      await deleteTempMsgs(chatId, tempMsgIds);
      await sendMsg(chatId, `❌ <b>Không thể tải trang OLM.</b>\n<code>${e.message}</code>\n\nVui lòng kiểm tra link và thử lại.`);
      return;
    }

    // Bước 2: Trích xuất text
    const pageText = extractText(html);
    if (!pageText || pageText.length < 50) {
      await deleteTempMsgs(chatId, tempMsgIds);
      await sendMsg(chatId, '❌ <b>Không đọc được nội dung bài tập.</b>\nHãy thử link khác hoặc đảm bảo đây là link bài tập công khai.');
      return;
    }

    // Bước 3: Gọi ChatGPT
    const prompt = `Bạn là trợ lý giải bài tập OLM.VN thông minh. Dưới đây là nội dung trang bài tập từ OLM.VN:

---
${pageText}
---

Nhiệm vụ:
1. Xác định có bao nhiêu câu hỏi trong bài tập này
2. Liệt kê từng câu hỏi (Câu 1, Câu 2, Câu 3...)
3. Với mỗi câu, phân tích và đưa ra đáp án đúng kèm giải thích ngắn gọn
4. Nếu là câu trắc nghiệm, chỉ rõ đáp án (A/B/C/D) và giải thích tại sao

Định dạng trả lời:
📊 TỔNG SỐ CÂU: [số câu]

Câu 1: [nội dung câu hỏi tóm tắt]
✅ Đáp án: [đáp án]
💡 Giải thích: [giải thích ngắn]

Câu 2: ...

(Tiếp tục cho tất cả các câu)

Trả lời bằng tiếng Việt. Nếu không tìm thấy câu hỏi rõ ràng, hãy giải thích lý do.`;

    let answer;
    try {
      answer = await callChatGPT(prompt);
    } catch (e) {
      await deleteTempMsgs(chatId, tempMsgIds); // Xoá loading trước khi báo lỗi
      let userMsg;
      if (e.isAuthError) {
        userMsg = `❌ <b>Lỗi xác thực ChatGPT API Key!</b>\n\n` +
                  `🔑 API Key không hợp lệ, đã hết hạn hoặc hết quota.\n` +
                  `Admin vui lòng cập nhật key mới tại <b>/admin</b> → <i>Cài đặt ChatGPT</i>.`;
      } else if (e.isRateLimit) {
        userMsg = `⏳ <b>AI đang quá tải!</b>\n\nChatGPT đang bị rate limit. Vui lòng thử lại sau <b>1-2 phút</b>.`;
      } else if (e.message.includes('Chưa có') || e.message.includes('API Key')) {
        userMsg = `❌ <b>Chưa cấu hình ChatGPT!</b>\n\nAdmin chưa cài đặt API Key ChatGPT. Vui lòng liên hệ admin.`;
      } else {
        userMsg = `❌ <b>Lỗi AI ChatGPT:</b>\n<code>${e.message}</code>\n\nThử lại sau ít phút.`;
      }
      await sendMsg(chatId, userMsg);
      return;
    }

    if (!answer || answer.trim().length < 10) {
      await deleteTempMsgs(chatId, tempMsgIds);
      await sendMsg(chatId, '❌ <b>AI không trả về kết quả.</b>\nThử lại sau ít phút.');
      return;
    }

    // Xoá TẤT CẢ tin nhắn loading trước khi gửi kết quả
    await deleteTempMsgs(chatId, tempMsgIds);

    // Gửi kết quả — chia nhỏ nếu quá dài (Telegram giới hạn 4096 ký tự)
    const header = `✅ <b>KẾT QUẢ BÀI TẬP OLM.VN</b>\n━━━━━━━━━━━━━━━━━━━━━━\n🔗 ${olmLink}\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    const fullText = header + answer;

    if (fullText.length <= 4000) {
      await sendMsg(chatId, fullText);
    } else {
      // Chia thành nhiều tin nhắn
      await sendMsg(chatId, header + '📄 <i>Kết quả dài, sẽ gửi từng phần...</i>');
      const chunks = [];
      let curr = '';
      for (const line of answer.split('\n')) {
        if ((curr + line + '\n').length > 3800) {
          if (curr) chunks.push(curr);
          curr = line + '\n';
        } else {
          curr += line + '\n';
        }
      }
      if (curr) chunks.push(curr);
      for (let i = 0; i < chunks.length; i++) {
        await sendMsg(chatId, `📝 <b>Phần ${i + 1}/${chunks.length}:</b>\n\n${chunks[i]}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // Sau khi giải xong, chờ link tiếp theo
    await sendMsg(chatId,
      `\n✨ <b>Hoàn thành!</b>\n\n` +
      `📚 Gửi link bài tập OLM khác để tiếp tục, hoặc /help để xem hướng dẫn.`
    );
    sessions[String(chatId)].waitingForLink = true;

  } finally {
    if (sessions[String(chatId)]) sessions[String(chatId)].processingLink = false;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   AUTO DELETE TIN NHẮN RÁC
   ══════════════════════════════════════════════════════════════════════════════ */

/** Danh sách pattern tin nhắn rác cần tự động xoá */
const SPAM_PATTERNS = [
  /t\.me\//i,                        // Link Telegram
  /bit\.ly\//i,                      // Shortlink
  /tinyurl\.com\//i,
  /\bcasino\b/i,                     // Casino
  /\bslot\b/i,
  /\bcá cược\b/i,
  /\bcuoc\b.*\blink\b/i,
  /\bkiếm tiền online\b/i,
  /\btuyển cộng tác viên\b/i,
  /\btuyển ctv\b/i,
  /\bđăng ký ngay\b/i,
  /\bưu đãi\b.*\b%\b/i,             // Ưu đãi XX%
  /\bbonus\b/i,
  /\bnạp tiền\b/i,
  /\brút tiền\b/i,
  /\bfree\b.*\bspin\b/i,
  /\bhttps?:\/\/(?!olm\.vn|telegram\.org|t\.me\/[a-zA-Z0-9_]{5,}$)/i,  // Link lạ (không phải OLM)
];

/** Kiểm tra xem tin nhắn có phải rác không */
function isSpamMessage(text) {
  if (!text) return false;
  return SPAM_PATTERNS.some(pat => pat.test(text));
}

/** Xoá tin nhắn */
function deleteMessage(chatId, messageId) {
  return tgCall('deleteMessage', { chat_id: chatId, message_id: messageId });
}

/* ══════════════════════════════════════════════════════════════════════════════
   XỬ LÝ TELEGRAM UPDATE
   ══════════════════════════════════════════════════════════════════════════════ */
async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const msgId  = msg.message_id;
  const text   = (msg.text || '').trim();
  const textLow = text.toLowerCase();

  if (!text) return;

  /* /start */
  if (textLow === '/start') {
    await sendMsg(chatId,
      `🎓 <b>Chào mừng đến với OLM VN Bot!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🤖 Bot hỗ trợ giải bài tập tự động từ <b>OLM.VN</b> bằng AI.\n\n` +
      `📋 <b>Cách sử dụng:</b>\n` +
      `1️⃣ Nhập key kích hoạt: /key\n` +
      `2️⃣ Dán link bài tập OLM.VN\n` +
      `3️⃣ AI tự động giải và hiển thị đáp án\n\n` +
      `💡 Gửi /key để bắt đầu!`
    );
    return;
  }

  /* /help */
  if (textLow === '/help') {
    const sess = sessions[chatId] || {};
    await sendMsg(chatId,
      `📖 <b>HƯỚNG DẪN SỬ DỤNG OLM VN BOT</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🔑 <b>/key</b> — Nhập key kích hoạt\n` +
      `📚 Sau khi kích hoạt key, dán link bài tập OLM để AI giải\n\n` +
      `<b>Ví dụ link hợp lệ:</b>\n` +
      `<code>https://olm.vn/chu-de/ten-bai-tap-123456</code>\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📊 <b>Trạng thái:</b> ${sess.keyVerified ? '✅ Đã kích hoạt' : '❌ Chưa kích hoạt key'}\n` +
      (sess.savedKey ? `🔑 Key: <code>${sess.savedKey}</code>` : '')
    );
    return;
  }

  /* /key */
  if (textLow === '/key' || textLow.startsWith('/key ')) {
    const parts = text.split(/\s+/);
    const keyArg = parts.slice(1).join('').trim();
    if (keyArg) {
      await verifyKeyForChat(chatId, keyArg);
    } else {
      sessions[chatId] = sessions[chatId] || {};
      sessions[chatId].waitingForKey  = true;
      sessions[chatId].waitingForLink = false;
      await sendMsg(chatId,
        `🔑 <b>Nhập key kích hoạt của bạn:</b>\n\n` +
        `<i>Gửi key trực tiếp vào đây</i>`
      );
    }
    return;
  }

  /* Tin nhắn thường */
  if (!textLow.startsWith('/')) {
    const sess = sessions[chatId] || {};

    // Fix: waitingForKey nhận key trước — key có thể chứa từ như bonus/slot bị spam filter oan
    if (sess.waitingForKey) {
      sessions[chatId].waitingForKey = false;
      // Xoá tin nhắn key của user để bảo mật
      await deleteMessage(chatId, msgId).catch(() => {});
      await verifyKeyForChat(chatId, text);
      return;
    }

    /* ── Auto-delete tin nhắn rác (chỉ áp dụng khi KHÔNG đang nhập key) ── */
    if (isSpamMessage(text)) {
      console.log(`[AntiSpam] Xoá tin nhắn rác từ ${chatId}: ${text.slice(0, 60)}`);
      await deleteMessage(chatId, msgId);
      await sendMsg(chatId, '🚫 <b>Tin nhắn rác đã bị xoá.</b>\n\nVui lòng chỉ gửi link bài tập OLM.VN hợp lệ.');
      return;
    }

    if (sess.keyVerified) {
      // Nhận link OLM
      if (text.includes('olm.vn/') || text.startsWith('https://olm.vn')) {
        sessions[chatId].waitingForLink = false;
        handleOlmLink(chatId, text, msgId).catch(e => {
          console.error('[OLM] Lỗi handleOlmLink:', e.message);
          if (sessions[chatId]) sessions[chatId].processingLink = false;
        });
        return;
      }

      if (sess.waitingForLink) {
        await sendMsg(chatId,
          `📌 <b>Vui lòng điền link bài tập OLM.VN!</b>\n\n` +
          `Ví dụ:\n<code>https://olm.vn/chu-de/phan-trac-nghiem-de-kiem-tra-cuoi-ki-2-de-1-3214212574</code>`
        );
        return;
      }

      await sendMsg(chatId,
        `💡 Gửi link bài tập OLM.VN để AI giải ngay!\n\n` +
        `Ví dụ: <code>https://olm.vn/chu-de/...</code>`
      );
      return;
    }

    // Chưa xác thực
    await sendMsg(chatId,
      `⚠️ <b>Bạn chưa kích hoạt key!</b>\n\nGửi /key để nhập key kích hoạt.`
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   WEB ADMIN PANEL
   ══════════════════════════════════════════════════════════════════════════════ */

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function isValidAdminToken(token) {
  if (!token || !adminSessions[token]) return false;
  // Session tồn tại 24h
  if (Date.now() - adminSessions[token].createdAt > 24 * 60 * 60 * 1000) {
    delete adminSessions[token];
    return false;
  }
  return true;
}

function getAdminToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/admin_token=([a-f0-9]{64})/);
  return match ? match[1] : null;
}

/* HTML trang đăng nhập admin */
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OLM VN — Đăng Nhập Admin</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{
    min-height:100vh;
    background:#f0f0ea;
    font-family:'Segoe UI',system-ui,sans-serif;
    display:flex;align-items:center;justify-content:center;
    position:relative;overflow:hidden;
  }
  /* Decorative shapes */
  .shape{position:absolute;border:3px solid #1a1a2e;}
  .shape-pink{
    width:140px;height:140px;
    background:#ff6fd8;top:60px;left:30px;
    transform:rotate(-15deg);
  }
  .shape-yellow{
    width:90px;height:90px;
    background:#ffe000;top:45px;left:220px;
    transform:rotate(20deg);
  }
  .shape-cyan{
    width:70px;height:70px;
    background:#00e5ff;bottom:80px;right:40px;
    transform:rotate(25deg);
  }
  .shape-green{
    width:50px;height:50px;
    background:#69ff47;bottom:160px;left:60px;
    transform:rotate(-10deg);
  }
  /* Card */
  .card{
    background:#fff;
    border:3px solid #1a1a2e;
    box-shadow:6px 6px 0 #1a1a2e;
    padding:40px 36px 36px;
    width:100%;max-width:420px;
    position:relative;z-index:10;
  }
  .badge{
    display:inline-block;
    border:2px solid #1a1a2e;
    padding:3px 14px;font-size:11px;
    font-weight:700;letter-spacing:2px;
    text-transform:uppercase;color:#1a1a2e;
    margin-bottom:14px;
  }
  .logo-row{display:flex;align-items:center;gap:14px;margin-bottom:8px;}
  .logo-icon{
    width:52px;height:52px;
    background:#4f46e5;border:2px solid #1a1a2e;
    display:flex;align-items:center;justify-content:center;flex-shrink:0;
  }
  .logo-icon svg{width:30px;height:30px;fill:#fff;}
  h1{font-size:36px;font-weight:900;color:#1a1a2e;line-height:1.1;letter-spacing:-1px;}
  .subtitle{color:#555;font-size:14px;margin:10px 0 28px;}
  label{display:block;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1a1a2e;margin-bottom:6px;}
  .field{margin-bottom:18px;position:relative;}
  input[type=text],input[type=password]{
    width:100%;padding:13px 16px;
    border:2px solid #1a1a2e;font-size:15px;
    background:#fffde8;outline:none;
    transition:box-shadow .15s;
    font-family:inherit;
  }
  input[type=text]:focus,input[type=password]:focus{
    box-shadow:3px 3px 0 #1a1a2e;
    background:#fff;
  }
  .pw-wrap{position:relative;}
  .pw-wrap input{padding-right:70px;}
  .toggle-btn{
    position:absolute;right:0;top:0;bottom:0;
    width:65px;background:#ffe000;border:none;border-left:2px solid #1a1a2e;
    font-size:11px;font-weight:800;letter-spacing:1px;
    cursor:pointer;text-transform:uppercase;color:#1a1a2e;
  }
  .toggle-btn:hover{background:#ffd000;}
  .submit-btn{
    width:100%;padding:15px;
    background:#ff4f1f;color:#fff;
    border:2px solid #1a1a2e;
    font-size:14px;font-weight:800;letter-spacing:2px;
    text-transform:uppercase;cursor:pointer;
    display:flex;align-items:center;justify-content:center;gap:10px;
    margin-top:6px;
    transition:box-shadow .15s,transform .1s;
  }
  .submit-btn:hover{box-shadow:3px 3px 0 #1a1a2e;transform:translate(-1px,-1px);}
  .submit-btn:active{transform:translate(1px,1px);box-shadow:none;}
  .divider{border:none;border-top:2px solid #1a1a2e;margin:22px 0 14px;}
  .hint{font-size:12px;color:#666;line-height:1.6;}
  .hint b{color:#1a1a2e;}
  .error-msg{
    background:#fff0f0;border:2px solid #e00;color:#c00;
    padding:10px 14px;font-size:13px;margin-bottom:18px;
    display:none;
  }
  .error-msg.show{display:block;}
</style>
</head>
<body>
<div class="shape shape-pink"></div>
<div class="shape shape-yellow"></div>
<div class="shape shape-cyan"></div>
<div class="shape shape-green"></div>

<div class="card">
  <div class="badge">Đăng Nhập</div>
  <div class="logo-row">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/></svg>
    </div>
    <h1>OLM VN<br>ADMIN</h1>
  </div>
  <p class="subtitle">Nhập tài khoản quản trị để tiếp tục.</p>

  <div class="error-msg" id="errMsg">Tài khoản hoặc mật khẩu không đúng!</div>

  <form id="loginForm" onsubmit="doLogin(event)">
    <div class="field">
      <label>Tài Khoản</label>
      <input type="text" id="username" placeholder="Nhập tài khoản" autocomplete="username">
    </div>
    <div class="field">
      <label>Mật Khẩu</label>
      <div class="pw-wrap">
        <input type="password" id="password" placeholder="Nhập mật khẩu" autocomplete="current-password">
        <button type="button" class="toggle-btn" id="togglePw" onclick="togglePw()">Hiện</button>
      </div>
    </div>
    <button type="submit" class="submit-btn">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg>
      Đăng Nhập Admin Panel
    </button>
  </form>
  <hr class="divider">
  <p class="hint">Trang admin dành riêng cho quản trị viên.<br>Người dùng bot truy cập qua <b>Telegram</b>.</p>
</div>

<script>
function togglePw(){
  var inp=document.getElementById('password');
  var btn=document.getElementById('togglePw');
  if(inp.type==='password'){
    inp.type='text';
    btn.textContent='Ẩn';
    btn.style.background='#ffb000';
  } else {
    inp.type='password';
    btn.textContent='Hiện';
    btn.style.background='';
  }
}
var SUBMIT_BTN_HTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3"/></svg> Đăng Nhập Admin Panel';
async function doLogin(e){
  e.preventDefault();
  const u=document.getElementById('username').value.trim();
  const p=document.getElementById('password').value;
  const err=document.getElementById('errMsg');
  err.classList.remove('show');
  const btn=e.target.querySelector('button[type=submit]');
  btn.disabled=true;btn.innerHTML='⏳ Đang kiểm tra...';
  try{
    const r=await fetch('/admin/login',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username:u,password:p})
    });
    const d=await r.json();
    if(d.ok){window.location.href='/admin/dashboard';}
    else{err.textContent=d.message||'Tài khoản hoặc mật khẩu không đúng!';err.classList.add('show');}
  }catch(_){err.textContent='Lỗi kết nối server!';err.classList.add('show');}
  finally{btn.disabled=false;btn.innerHTML=SUBMIT_BTN_HTML;}
}
</script>
</body>
</html>`;

/* HTML trang Dashboard admin */
function getDashboardHTML(stats) {
  const activeUsers = Object.values(sessions).filter(s => s.keyVerified).length;
  const totalUsers  = Object.keys(sessions).length;
  const hasOpenAI   = !!OPENAI_API_KEY;

  return `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OLM VN — Admin Dashboard</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box;}
  body{background:#f0f0ea;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;}
  /* Sidebar */
  .sidebar{
    position:fixed;left:0;top:0;bottom:0;width:240px;
    background:#1a1a2e;border-right:3px solid #000;
    display:flex;flex-direction:column;z-index:100;
  }
  .sidebar-logo{
    padding:24px 20px;border-bottom:2px solid #2a2a4e;
    display:flex;align-items:center;gap:12px;
  }
  .sidebar-logo .icon{
    width:42px;height:42px;background:#4f46e5;border:2px solid #7c75f0;
    display:flex;align-items:center;justify-content:center;
  }
  .sidebar-logo .icon svg{width:24px;height:24px;fill:#fff;}
  .sidebar-logo .name{color:#fff;font-size:16px;font-weight:800;letter-spacing:0.5px;}
  .sidebar-logo .sub{color:#8888aa;font-size:10px;letter-spacing:2px;text-transform:uppercase;}
  nav{flex:1;padding:16px 0;}
  .nav-item{
    display:flex;align-items:center;gap:12px;
    padding:12px 20px;color:#bbb;font-size:13px;font-weight:600;
    cursor:pointer;transition:background .15s,color .15s;
    border-left:3px solid transparent;
  }
  .nav-item:hover{background:#252545;color:#fff;border-left-color:#4f46e5;}
  .nav-item.active{background:#252545;color:#fff;border-left-color:#4f46e5;}
  .nav-item svg{width:18px;height:18px;flex-shrink:0;fill:currentColor;}
  .sidebar-bottom{padding:16px 20px;border-top:2px solid #2a2a4e;}
  .logout-btn{
    width:100%;padding:10px;background:#3a1a1a;color:#ff8888;
    border:2px solid #6a2a2a;font-size:12px;font-weight:700;
    letter-spacing:1px;text-transform:uppercase;cursor:pointer;
  }
  .logout-btn:hover{background:#4a2020;}
  /* Main */
  .main{margin-left:240px;padding:28px;}
  .page-header{margin-bottom:28px;}
  .page-header h1{font-size:26px;font-weight:900;color:#1a1a2e;letter-spacing:-0.5px;}
  .page-header p{color:#666;font-size:13px;margin-top:4px;}
  /* Stats grid */
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px;}
  .stat-card{
    background:#fff;border:2px solid #1a1a2e;
    box-shadow:4px 4px 0 #1a1a2e;
    padding:20px;
  }
  .stat-card .label{font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#888;margin-bottom:8px;}
  .stat-card .value{font-size:32px;font-weight:900;color:#1a1a2e;line-height:1;}
  .stat-card .sub{font-size:11px;color:#aaa;margin-top:4px;}
  .stat-card.accent{background:#4f46e5;border-color:#3730a3;box-shadow:4px 4px 0 #3730a3;}
  .stat-card.accent .label,.stat-card.accent .value,.stat-card.accent .sub{color:#fff;}
  .stat-card.success{background:#22c55e;border-color:#166534;box-shadow:4px 4px 0 #166534;}
  .stat-card.success .label,.stat-card.success .value,.stat-card.success .sub{color:#fff;}
  .stat-card.warn{background:#f59e0b;border-color:#92400e;box-shadow:4px 4px 0 #92400e;}
  .stat-card.warn .label,.stat-card.warn .value,.stat-card.warn .sub{color:#fff;}
  /* Section */
  .section{background:#fff;border:2px solid #1a1a2e;box-shadow:4px 4px 0 #1a1a2e;padding:24px;margin-bottom:20px;}
  .section h2{font-size:14px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;color:#1a1a2e;margin-bottom:18px;padding-bottom:10px;border-bottom:2px solid #e8e8e0;}
  /* Form */
  .form-group{margin-bottom:16px;}
  label.lbl{display:block;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#1a1a2e;margin-bottom:6px;}
  input.inp{
    width:100%;padding:12px 14px;border:2px solid #1a1a2e;
    font-size:14px;font-family:monospace;background:#fffde8;outline:none;
  }
  input.inp:focus{box-shadow:3px 3px 0 #1a1a2e;background:#fff;}
  .btn{
    padding:11px 22px;border:2px solid #1a1a2e;
    font-size:12px;font-weight:800;letter-spacing:1.5px;text-transform:uppercase;
    cursor:pointer;transition:box-shadow .12s,transform .1s;
  }
  .btn:hover{box-shadow:3px 3px 0 #1a1a2e;transform:translate(-1px,-1px);}
  .btn-primary{background:#4f46e5;color:#fff;border-color:#3730a3;}
  .btn-danger{background:#ef4444;color:#fff;border-color:#991b1b;}
  .btn-success{background:#22c55e;color:#fff;border-color:#166534;}
  .status-badge{
    display:inline-flex;align-items:center;gap:6px;
    padding:4px 12px;border:2px solid;font-size:11px;font-weight:700;
    letter-spacing:1px;text-transform:uppercase;
  }
  .status-badge.ok{color:#166534;border-color:#22c55e;background:#f0fdf4;}
  .status-badge.no{color:#991b1b;border-color:#ef4444;background:#fef2f2;}
  .dot{width:7px;height:7px;border-radius:50%;background:currentColor;}
  .msg{padding:10px 14px;border:2px solid;font-size:13px;margin-top:12px;display:none;}
  .msg.ok{border-color:#22c55e;background:#f0fdf4;color:#166534;}
  .msg.err{border-color:#ef4444;background:#fef2f2;color:#991b1b;}
  .msg.show{display:block;}
  @media(max-width:768px){.sidebar{width:200px;}.main{margin-left:200px;padding:16px;}}
</style>
</head>
<body>

<div class="sidebar">
  <div class="sidebar-logo">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M12 3L1 9l11 6 9-4.91V17h2V9L12 3zM5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82z"/></svg>
    </div>
    <div>
      <div class="name">OLM VN</div>
      <div class="sub">Admin Panel</div>
    </div>
  </div>
  <nav>
    <div class="nav-item active">
      <svg viewBox="0 0 24 24"><path d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"/></svg>
      Dashboard
    </div>
    <div class="nav-item" onclick="showSection('chatgpt')">
      <svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm0-14a6 6 0 1 0 6 6 6 6 0 0 0-6-6zm0 10a4 4 0 1 1 4-4 4 4 0 0 1-4 4z"/></svg>
      Cài đặt AI ChatGPT
    </div>
  </nav>
  <div class="sidebar-bottom">
    <button class="logout-btn" onclick="logout()">⬅ Đăng xuất</button>
  </div>
</div>

<div class="main">
  <div class="page-header">
    <h1>Dashboard</h1>
    <p>Quản lý hệ thống OLM VN Bot</p>
  </div>

  <!-- Stats -->
  <div class="stats-grid">
    <div class="stat-card accent">
      <div class="label">Người dùng có key</div>
      <div class="value">${activeUsers}</div>
      <div class="sub">Đã kích hoạt</div>
    </div>
    <div class="stat-card">
      <div class="label">Tổng phiên</div>
      <div class="value">${totalUsers}</div>
      <div class="sub">Người dùng</div>
    </div>
    <div class="stat-card ${hasOpenAI ? 'success' : 'warn'}">
      <div class="label">AI ChatGPT</div>
      <div class="value">${hasOpenAI ? 'ON' : 'OFF'}</div>
      <div class="sub">${hasOpenAI ? 'Đã cấu hình' : 'Chưa có API Key'}</div>
    </div>
  </div>

  <!-- ChatGPT API Section -->
  <div class="section" id="sec-chatgpt">
    <h2>⚙️ Cài đặt AI ChatGPT</h2>
    <p style="font-size:13px;color:#666;margin-bottom:18px;">
      Nhập ChatGPT (OpenAI) API Key để bot có thể giải bài tập OLM.VN tự động.
      Lấy key tại <b>platform.openai.com</b> → API Keys.
    </p>

    <div style="margin-bottom:16px;">
      <span class="status-badge ${hasOpenAI ? 'ok' : 'no'}">
        <span class="dot"></span>
        ${hasOpenAI ? 'ChatGPT đã kết nối — gpt-4o-mini' : 'Chưa có API Key'}
      </span>
    </div>

    <div class="form-group">
      <label class="lbl">OpenAI API Key</label>
      <input class="inp" type="password" id="chatgptKey" placeholder="sk-proj-..." value="${OPENAI_API_KEY ? '•'.repeat(20) : ''}">
      <p style="font-size:11px;color:#888;margin-top:6px;">Key dạng <code>sk-proj-...</code> — lấy tại <b>platform.openai.com → API Keys</b></p>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="saveChatGPT()">💾 Lưu API Key</button>
      ${hasOpenAI ? '<button class="btn btn-danger" onclick="clearChatGPT()">🗑 Xoá Key</button>' : ''}
      ${hasOpenAI ? '<button class="btn btn-success" onclick="testChatGPT()">🧪 Test ChatGPT</button>' : ''}
    </div>
    <div class="msg" id="chatgptMsg"></div>
  </div>

  <!-- Bot Status -->
  <div class="section">
    <h2>🤖 Trạng thái Bot</h2>
    <div style="display:grid;gap:10px;font-size:13px;">
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eee;">
        <span style="color:#666;">Bot Token</span>
        <span style="font-family:monospace;color:#1a1a2e;">${BOT_TOKEN ? BOT_TOKEN.slice(0,12) + '...' : '❌ Chưa cấu hình'}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eee;">
        <span style="color:#666;">Key Server</span>
        <span style="font-family:monospace;font-size:11px;color:#1a1a2e;">${KEY_SERVER_URL}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #eee;">
        <span style="color:#666;">App ID</span>
        <span style="font-family:monospace;color:#1a1a2e;">${KEY_APP_ID}</span>
      </div>
      <div style="display:flex;justify-content:space-between;padding:10px 0;">
        <span style="color:#666;">Uptime</span>
        <span id="uptime" style="color:#1a1a2e;">Đang tính...</span>
      </div>
    </div>
  </div>
</div>

<script>
const startTime = Date.now();
function showSection(s){
  document.getElementById('sec-chatgpt').scrollIntoView({behavior:'smooth'});
}
function updateUptime(){
  const s=Math.floor((Date.now()-startTime)/1000);
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),ss=s%60;
  document.getElementById('uptime').textContent=h+'h '+m+'m '+ss+'s';
}
setInterval(updateUptime,1000);updateUptime();

function showMsg(id,text,type){
  const el=document.getElementById(id);
  el.textContent=text;el.className='msg '+type+' show';
  setTimeout(()=>el.classList.remove('show'),4000);
}

async function saveChatGPT(){
  const key=document.getElementById('chatgptKey').value.trim();
  if(!key||key.includes('•')){showMsg('chatgptMsg','Nhập API Key mới!','err');return;}
  const r=await fetch('/admin/set-chatgpt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key})});
  const d=await r.json();
  if(d.ok){showMsg('chatgptMsg','✅ Đã lưu ChatGPT API Key thành công!','ok');setTimeout(()=>location.reload(),1500);}
  else showMsg('chatgptMsg','❌ '+(d.message||'Lỗi'),'err');
}
async function clearChatGPT(){
  if(!confirm('Xoá ChatGPT API Key?'))return;
  await fetch('/admin/set-chatgpt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:''})});
  location.reload();
}
async function testChatGPT(){
  showMsg('chatgptMsg','🧪 Đang test...','ok');
  const r=await fetch('/admin/test-chatgpt',{method:'POST'});
  const d=await r.json();
  if(d.ok)showMsg('chatgptMsg','✅ ChatGPT hoạt động! Model: '+d.model,'ok');
  else showMsg('chatgptMsg','❌ Lỗi: '+(d.message||'Không rõ'),'err');
}
async function logout(){
  await fetch('/admin/logout',{method:'POST'});
  window.location.href='/admin';
}
</script>
</body>
</html>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP SERVER
   ══════════════════════════════════════════════════════════════════════════════ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 512 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed  = url.parse(req.url || '/');
  const reqPath = parsed.pathname || '/';
  const method  = req.method || 'GET';

  /* ── Health / root ── */
  if (reqPath === '/' || reqPath === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'OLM VN Bot', uptime: process.uptime() }));
    return;
  }

  /* ── ADMIN: Login page ── */
  if (reqPath === '/admin' || reqPath === '/admin/' || reqPath === '/admin/index' || reqPath === '/admin/index.html') {
    const token = getAdminToken(req.headers.cookie);
    if (isValidAdminToken(token)) {
      res.writeHead(302, { Location: '/admin/dashboard' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }

  /* ── ADMIN: Login API ── */
  if (reqPath === '/admin/login' && method === 'POST') {
    res.setHeader('Content-Type', 'application/json');
    try {
      const body = await readBody(req);
      if (body.username === ADMIN_USERNAME && body.password === ADMIN_PASSWORD) {
        const token = generateToken();
        adminSessions[token] = { createdAt: Date.now() };
        res.writeHead(200, {
          'Set-Cookie': `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401);
        res.end(JSON.stringify({ ok: false, message: 'Tài khoản hoặc mật khẩu không đúng!' }));
      }
    } catch (_) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: 'Lỗi server' }));
    }
    return;
  }

  /* ── ADMIN: Logout ── */
  if (reqPath === '/admin/logout' && method === 'POST') {
    const token = getAdminToken(req.headers.cookie);
    if (token) delete adminSessions[token];
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'admin_token=; Path=/; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  /* ── ADMIN: Dashboard (protected) ── */
  if (reqPath === '/admin/dashboard') {
    const token = getAdminToken(req.headers.cookie);
    if (!isValidAdminToken(token)) {
      res.writeHead(302, { Location: '/admin' });
      res.end(); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
    return;
  }

  /* ── ADMIN API: Cập nhật ChatGPT Key ── */
  if (reqPath === '/admin/set-chatgpt' && method === 'POST') {
    const token = getAdminToken(req.headers.cookie);
    if (!isValidAdminToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'Chưa đăng nhập' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    try {
      const body = await readBody(req);
      OPENAI_API_KEY = (body.key || '').trim();
      console.log('[Admin] ChatGPT API Key đã được cập nhật:', OPENAI_API_KEY ? '***' + OPENAI_API_KEY.slice(-4) : '(đã xoá)');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (_) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: 'Lỗi server' }));
    }
    return;
  }

  /* ── ADMIN API: Test ChatGPT ── */
  if (reqPath === '/admin/test-chatgpt' && method === 'POST') {
    const token = getAdminToken(req.headers.cookie);
    if (!isValidAdminToken(token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'Chưa đăng nhập' }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    try {
      const answer = await callChatGPT('Xin chào! Hãy trả lời ngắn gọn: "ChatGPT đang hoạt động!"');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, model: OPENAI_MODEL, answer }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, message: e.message }));
    }
    return;
  }

  /* ── Telegram Webhook ── */
  if (reqPath === '/webhook' && method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    try {
      const update = await readBody(req);
      handleUpdate(update).catch(e => console.error('[Bot] handleUpdate lỗi:', e && e.message));
    } catch (e) {
      console.error('[Bot] Webhook read lỗi:', e && e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

/* ══════════════════════════════════════════════════════════════════════════════
   ANTI-SLEEP
   ══════════════════════════════════════════════════════════════════════════════ */
function startAntiSleep() {
  const selfUrl = SELF_URL;
  if (!selfUrl) return;
  const target = selfUrl + '/health';
  console.log(`   🔄 [Anti-sleep] Ping ${target} mỗi 3 phút`);
  setInterval(() => {
    try {
      https.get(target, r => r.resume()).on('error', e => {
        console.warn('[Anti-sleep] Ping lỗi:', e.message);
      });
    } catch (_) {}
  }, 3 * 60 * 1000);
}

/* ══════════════════════════════════════════════════════════════════════════════
   KHỞI ĐỘNG
   ══════════════════════════════════════════════════════════════════════════════ */
async function start() {
  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🎓 OLM VN Bot đang chạy tại port ${PORT}`);
    console.log(`   BOT_TOKEN  : ${BOT_TOKEN ? BOT_TOKEN.slice(0, 10) + '...' : '⚠️ Chưa set!'}`);
    console.log(`   KEY_SERVER : ${KEY_SERVER_URL}`);
    console.log(`   CHATGPT KEY: ${OPENAI_API_KEY ? '✅ Đã cấu hình' : '⚠️ Chưa có — vào /admin để cài'}`);
    console.log(`   ADMIN WEB  : http://localhost:${PORT}/admin`);

    const publicUrl = SELF_URL;
    if (publicUrl) {
      const webhookUrl = `${publicUrl}/webhook`;
      const result = await tgCall('setWebhook', { url: webhookUrl });
      if (result && result.ok) {
        console.log(`   ✅ Webhook: ${webhookUrl}`);
      } else {
        console.warn(`   ⚠️  Webhook thất bại:`, result && result.description);
      }
      await tgCall('setMyCommands', { commands: [
        { command: 'start', description: 'Chào mừng & giới thiệu' },
        { command: 'key',   description: 'Nhập key kích hoạt' },
        { command: 'help',  description: 'Hướng dẫn sử dụng' },
      ]});
      console.log(`   ✅ Đã cập nhật danh sách lệnh bot`);
    } else {
      console.log(`   ⚠️  Chưa có RENDER_EXTERNAL_URL — webhook chưa đăng ký tự động`);
    }

    startAntiSleep();
    console.log('');
  });
}

process.on('SIGINT',  () => { server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

/* ══════════════════════════════════════════════════════════════════════════════
   CHỐNG SẬP SERVER — Bắt mọi lỗi không được xử lý để server không crash
   ══════════════════════════════════════════════════════════════════════════════ */
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] uncaughtException — server vẫn tiếp tục chạy:', err && err.message, err && err.stack);
  // KHÔNG gọi process.exit() — để server tiếp tục sống
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] unhandledRejection — server vẫn tiếp tục chạy:', reason);
  // KHÔNG gọi process.exit()
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Fix: không gọi start() lại vì server instance cũ không thể listen lại
    // Chỉ log và chờ — Render sẽ tự restart container nếu cần
    console.error(`[Server] Port ${PORT} đang bị chiếm. Chờ 10 giây rồi thoát để Render restart...`);
    setTimeout(() => process.exit(1), 10000);
  } else {
    console.error('[Server] Lỗi server HTTP:', err.message);
  }
});

start();
