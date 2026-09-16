const fs = require('fs');
const path = require('path');

let timer = null;
let isPolling = false;
let isInitialized = false;
let lastCommentIndex = -1;
let lastErrorStatus = null;
let resolvedServiceId = null;
let currentDir = __dirname;

// ステータス管理
let statusState = {
  status: 'idle', // idle, connecting, active, error, auth_error
  message: '待機中',
  lastCommentTime: null,
  totalReceived: 0,
  channelId: ''
};

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

      // 接続スロットを消費しないよう、枠を常にOFF（enabled: false）に維持
      if (target.enabled) {
        fetch(`http://localhost:11180/api/services/${encodeURIComponent(target.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...target, enabled: false, url: '', meta: {} })
        }).catch(() => {});
      }

      return target.id;
    }
  } catch (err) {
    console.warn('[fc2-plugin] 枠一覧の取得に失敗:', err.message);
  }
  return null;
}

// 接続数制限を回避するため、わんコメ枠は常にOFF（未接続）のまま維持
async function ensureServiceEnabled(serviceId) {
  // 枠を勝手にON（enabled: true）にしない（上限エラー防止）
  return;
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

    statusState.totalReceived++;
    statusState.lastCommentTime = Date.now();
  }
}

async function fetchFC2Comments(channelId, token, serviceId) {
  const url = `https://live.fc2.com/api/getChannelComment.php?channel_id=${encodeURIComponent(channelId)}&token=${encodeURIComponent(token)}&last_comment_index=${lastCommentIndex}`;

  const res = await fetch(url);
  if (!res.ok) {
    statusState.status = 'error';
    statusState.message = `HTTPエラー: ${res.status}`;
    throw new Error(`HTTPエラー: ${res.status}`);
  }

  const data = await res.json();

  if (data.status !== 0) {
    if (data.status !== lastErrorStatus) {
      lastErrorStatus = data.status;
      if (data.status === 11) {
        statusState.status = 'auth_error';
        statusState.message = '認証エラー (Token無効 または 配信枠未開始)';
        console.warn(`[fc2-plugin] FC2 API ステータス 11: 認証エラー、または配信が開始されていない可能性があります。(channel_id: ${channelId})`);
      } else {
        statusState.status = 'error';
        statusState.message = `FC2エラー: Status ${data.status}`;
        console.warn(`[fc2-plugin] FC2 API エラーステータス: ${data.status}`);
      }
    }
    return;
  }

  statusState.status = 'active';
  statusState.message = '受信中（正常稼働）';

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
}

function startPolling(dir) {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  isPolling = false;
  resetState();

  const configPath = path.join(dir, 'config.json');
  if (!fs.existsSync(configPath)) {
    statusState.status = 'idle';
    statusState.message = '設定未完了 (config.json なし)';
    return;
  }

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    statusState.status = 'error';
    statusState.message = 'config.json パースエラー';
    return;
  }

  const { channel_id, token, serviceId: configuredServiceId } = config;
  statusState.channelId = channel_id || '';

  if (!channel_id || !token || channel_id.includes('ここに') || token.includes('ここに')) {
    statusState.status = 'idle';
    statusState.message = '設定未完了（IDまたはトークンが未入力）';
    return;
  }

  statusState.status = 'connecting';
  statusState.message = '接続確認中...';

  const poll = async () => {
    if (isPolling) return;
    isPolling = true;

    try {
      if (!fs.existsSync(configPath)) return;
      const conf = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const cid = conf.channel_id;
      const tok = conf.token;
      const sId = await resolveServiceId(conf.serviceId);

      if (!cid || !tok || cid.includes('ここに') || tok.includes('ここに')) {
        return;
      }

      if (!sId) {
        statusState.status = 'error';
        statusState.message = 'わんコメ枠が見つかりません';
        console.warn('[fc2-plugin] わんコメにFC2用の配信枠が見つかりません。');
        return;
      }

      await fetchFC2Comments(cid, tok, sId);
    } catch (err) {
      console.error('[fc2-plugin] ポーリングエラー:', err.message || err);
    } finally {
      isPolling = false;
    }
  };

  let intervalMs = 2500;
  if (config.intervalMs && config.intervalMs >= 1000) {
    intervalMs = config.intervalMs;
  }

  timer = setInterval(poll, intervalMs);
  poll(); // 初回即時実行
  console.info(`[fc2-plugin] 監視ループを開始しました (${intervalMs}ms 間隔)`);
}

const plugin = {
  name: 'FC2ライブ コメント連携',
  uid: 'com.fc2live.comment-sync',
  version: '1.4.0',
  author: 'orangeqoon',
  url: 'https://github.com/orangeqoon/onecomme-plugin-fc2',
  permissions: ['comments'],
  defaultState: {},

  init({ dir }) {
    currentDir = dir;
    console.info('[fc2-plugin] 初期化開始 (FC2ライブ コメント連携 v1.4.0)');
    const configPath = path.join(dir, 'config.json');
    const sampleConfigPath = path.join(dir, 'config.sample.json');

    if (!fs.existsSync(configPath)) {
      if (fs.existsSync(sampleConfigPath)) {
        fs.copyFileSync(sampleConfigPath, configPath);
      } else {
        const initialConfig = {
          channel_id: "",
          token: "",
          serviceId: "",
          intervalMs: 2500
        };
        fs.writeFileSync(configPath, JSON.stringify(initialConfig, null, 2), 'utf8');
      }
    }

    startPolling(dir);
  },

  // わんコメ Web API 通信ハンドラ (/api/plugins/com.fc2live.comment-sync)
  async request(req) {
    const configPath = path.join(currentDir, 'config.json');

    // GET: 現在の設定と稼働ステータスを返却
    if (req.method === 'GET') {
      let config = { channel_id: '', token: '', serviceId: '', intervalMs: 2500 };
      try {
        if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }
      } catch (_) {}

      return {
        code: 200,
        body: {
          config,
          status: statusState
        }
      };
    }

    // POST: 設定の更新 & 即時リスタート
    if (req.method === 'POST') {
      try {
        const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        let config = {};
        if (fs.existsSync(configPath)) {
          try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch (_) {}
        }

        if (body.channel_id !== undefined) config.channel_id = String(body.channel_id).trim();
        if (body.token !== undefined) config.token = String(body.token).trim();
        if (body.serviceId !== undefined) config.serviceId = String(body.serviceId).trim();
        if (body.intervalMs !== undefined) config.intervalMs = Math.max(1000, Number(body.intervalMs) || 2500);

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
        console.info('[fc2-plugin] Web設定画面から設定が更新されました。再接続します...');

        startPolling(currentDir);

        return {
          code: 200,
          body: {
            success: true,
            config,
            status: statusState
          }
        };
      } catch (err) {
        return {
          code: 400,
          body: { success: false, error: err.message }
        };
      }
    }

    return { code: 405, body: { error: 'Method Not Allowed' } };
  },

  destroy() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    isPolling = false;
    resetState();
    statusState.status = 'idle';
    statusState.message = '停止中';
    console.info('[fc2-plugin] プラグインを停止しました');
  }
};

module.exports = plugin;
