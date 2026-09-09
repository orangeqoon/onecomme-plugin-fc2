const fs = require('fs');
const path = require('path');

let timer = null;
let isPolling = false;
let isInitialized = false;
let lastCommentIndex = -1;
let lastErrorStatus = null;
let resolvedServiceId = null;

// 匿名ユーザー用通し番号テーブル
const anonymousMap = new Map();
let anonymousCounter = 1;

// ギフト名定義（FC2公式準拠）
const GIFT_LIST = [
  '風船', 'ハート', 'ダイヤ', 'ドーナツ', 'ニンジャ',
  'キャンディ', 'クラッカー', '花火', 'キッス', 'いいね',
  '車', 'さかな', 'UFO', 'シャンパン'
];
GIFT_LIST[999] = 'オチャコ';

function getAnonymousName(hash) {
  if (!hash) return '匿名';
  if (!anonymousMap.has(hash)) {
    anonymousMap.set(hash, anonymousCounter++);
  }
  return `匿名(${anonymousMap.get(hash)})`;
}

function resetState() {
  anonymousMap.clear();
  anonymousCounter = 1;
  lastCommentIndex = -1;
  isInitialized = false;
  lastErrorStatus = null;
  resolvedServiceId = null;
}

// わんコメ内の枠IDを自動解決（未指定なら枠名・URLから自動検出）
async function resolveServiceId(configuredId) {
  if (configuredId && !configuredId.includes('ここに') && configuredId.trim() !== '') {
    return configuredId.trim();
  }
  if (resolvedServiceId) return resolvedServiceId;

  try {
    const res = await fetch('http://localhost:11180/api/services');
    if (!res.ok) return null;
    const services = await res.json();
    const target = services.find(s => {
      const name = (s.name || '').toLowerCase();
      const url = (s.url || '').toLowerCase();
      return name.includes('fc2') || url.includes('fc2.com');
    });

    if (target) {
      resolvedServiceId = target.id;
      console.info(`[fc2-plugin] わんコメの枠 '${target.name}' (ID: ${target.id}) を自動検出しました！`);
      return target.id;
    }
  } catch (err) {
    console.warn('[fc2-plugin] 枠一覧の取得に失敗:', err.message);
  }
  return null;
}

// 枠がOFFになってビューアから消えるのを防ぐため、自動で有効化
async function ensureServiceEnabled(serviceId) {
  if (!serviceId) return;
  try {
    await fetch(`http://localhost:11180/api/services/${encodeURIComponent(serviceId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, write: true })
    });
  } catch (_) {}
}

// コメント送信処理
async function sendCommentsToOnecomme(comments, serviceId) {
  await ensureServiceEnabled(serviceId);

  for (const item of comments) {
    let userName = item.user_name || '名無し';
    if (item.anonymous) {
      userName = getAnonymousName(item.hash);
    } else if (item.ng_name) {
      userName = '-NG-';
    }

    let commentText = item.comment || '';
    let hasGift = false;

    if (item.system_comment) {
      const sys = item.system_comment;
      if (sys.type === 'tip') {
        commentText = `${sys.tip_amount} pt を${userName}さんがチップしました。`;
        hasGift = true;
      } else if (sys.type === 'gift') {
        const giftName = GIFT_LIST[sys.gift_id] || '何か';
        commentText = `${giftName} を${userName}さんがプレゼントしました。`;
        hasGift = true;
      }
      if (item.ng_name) {
        commentText = '--NGキーワードが含まれるコメントです--';
      }
    }

    if (item.ng_comment_keyword) {
      commentText = '--NGキーワードが含まれるコメントです--';
    } else if (item.ng_comment_user) {
      commentText = '--NGユーザーのコメントです--';
    }

    const isOwner = Boolean(item.owner === 1 || item.owner === true);

    const payload = {
      service: {
        id: serviceId,
        write: true,
        speech: true,
        persist: true
      },
      comment: {
        id: String(item.timestamp || Date.now()) + '_' + Math.random().toString(36).substring(2, 7),
        userId: String(item.hash || (isOwner ? 'owner' : 'unknown')),
        name: isOwner ? `${userName} (配信者)` : userName,
        badges: [],
        profileImage: '',
        comment: commentText,
        hasGift: hasGift,
        isOwner: isOwner,
        timestamp: item.timestamp ? Number(item.timestamp) : Date.now()
      }
    };

    await fetch('http://localhost:11180/api/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => {
      console.error('[fc2-plugin] わんコメへのコメント送信エラー:', err.message);
    });
  }
}

const plugin = {
  name: 'FC2ライブ コメント連携',
  uid: 'com.fc2live.comment-sync',
  version: '1.3.0',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-fc2',
  permissions: ['comments'],
  defaultState: {},

  init({ dir }) {
    console.info('[fc2-plugin] 初期化開始 (FC2ライブ コメント連携 v1.3.0)');
    const configPath = path.join(dir, 'config.json');
    const sampleConfigPath = path.join(dir, 'config.sample.json');

    // config.json が無い場合は雛形を自動作成
    if (!fs.existsSync(configPath)) {
      if (fs.existsSync(sampleConfigPath)) {
        fs.copyFileSync(sampleConfigPath, configPath);
      } else {
        const initialConfig = {
          channel_id: "あなたのFC2チャンネルID（数字）",
          token: "FC2コメントAPIトークン",
          serviceId: "",
          intervalMs: 2500
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), 'utf8');
      }
      console.info('[fc2-plugin] config.json を作成しました。設定を入力してください。');
      return;
    }

    const fetchFC2Comments = async (channelId, token, serviceId) => {
      const url = `https://live.fc2.com/api/getChannelComment.php?channel_id=${encodeURIComponent(channelId)}&token=${encodeURIComponent(token)}&last_comment_index=${lastCommentIndex}`;

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTPエラー: ${res.status}`);
      }

      const data = await res.json();

      if (data.status !== 0) {
        if (data.status !== lastErrorStatus) {
          lastErrorStatus = data.status;
          if (data.status === 11) {
            console.warn(`[fc2-plugin] FC2 API ステータス 11: 認証エラー、または配信が開始されていない可能性があります。(channel_id: ${channelId})`);
          } else {
            console.warn(`[fc2-plugin] FC2 API エラーステータス: ${data.status}`);
          }
        }
        return;
      }

      if (lastErrorStatus !== null) {
        console.info('[fc2-plugin] FC2 APIへの接続が正常になりました。');
        lastErrorStatus = null;
      }

      // 初回接続時: 直近15分以内のコメントを取り込む
      if (!isInitialized) {
        lastCommentIndex = typeof data.last_comment_index === 'number' ? data.last_comment_index : -1;
        isInitialized = true;

        const now = Date.now();
        const recentThreshold = now - (15 * 60 * 1000);
        const allComments = Array.isArray(data.comments) ? data.comments : [];
        const recentComments = allComments.filter(c => c.timestamp && Number(c.timestamp) >= recentThreshold);

        if (recentComments.length > 0) {
          console.info(`[fc2-plugin] 初回接続成功！直近15分以内のコメント ${recentComments.length} 件を取り込みます (最新Index: ${lastCommentIndex})`);
          await sendCommentsToOnecomme(recentComments, serviceId);
        } else {
          console.info(`[fc2-plugin] 初回接続成功！最新コメントIndex: ${lastCommentIndex} (過去コメント ${allComments.length} 件をスキップして新着待機)`);
        }
        return;
      }

      // 2回目以降の新着コメント処理
      if (typeof data.last_comment_index === 'number' && data.last_comment_index > lastCommentIndex) {
        lastCommentIndex = data.last_comment_index;
      }

      if (Array.isArray(data.comments) && data.comments.length > 0) {
        await sendCommentsToOnecomme(data.comments, serviceId);
      }
    };

    const poll = async () => {
      if (isPolling) return;
      isPolling = true;

      try {
        if (!fs.existsSync(configPath)) return;
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const { channel_id, token, serviceId: configuredServiceId } = config;

        if (!channel_id || !token || channel_id.includes('ここに') || token.includes('ここに')) {
          return;
        }

        const serviceId = await resolveServiceId(configuredServiceId);
        if (!serviceId) {
          console.warn('[fc2-plugin] わんコメにFC2用の配信枠が見つかりません。わんコメで枠を追加（枠名を「FC2」にするか、URLに「live.fc2.com」を設定）してください。');
          return;
        }

        await fetchFC2Comments(channel_id, token, serviceId);
      } catch (err) {
        console.error('[fc2-plugin] ポーリング中エラー:', err.message || err);
      } finally {
        isPolling = false;
      }
    };

    let intervalMs = 2500;
    try {
      if (fs.existsSync(configPath)) {
        const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (conf.intervalMs && conf.intervalMs >= 1000) {
          intervalMs = conf.intervalMs;
        }
      }
    } catch (_) {}

    timer = setInterval(poll, intervalMs);
    console.info(`[fc2-plugin] 監視ループを開始しました (${intervalMs}ms 間隔)`);
  },

  destroy() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling = false;
    resetState();
    console.info('[fc2-plugin] プラグインを停止しました');
  }
};

module.exports = plugin;
