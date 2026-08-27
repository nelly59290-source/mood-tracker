// mood-tracker 저녁 리마인더 푸시 발송용 Cloudflare Worker.
// - POST /subscribe   구독 등록 (앱에서 알림 켤 때)
// - POST /unsubscribe 구독 해제
// - POST /test        지금 바로 한 번 보내보기
// - GET  /health      상태 확인
// - cron              매일 20:00 KST (= 11:00 UTC) 전체 발송

import { sendPushNotification, deserializeVapidKeys } from 'web-push-browser';

// 이 Worker는 인증이 없다. 공개 앱이라 클라이언트에 숨길 비밀이 없기 때문.
// 대신 구독 수를 막아둬서 아무나 대량 등록하지 못하게 한다.
const MAX_SUBS = 10;

const ALLOWED_ORIGINS = [
  'https://nelly59290-source.github.io',
  'http://localhost:8899'
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }
  });
}

async function subKey(endpoint) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  return 'sub:' + hex.slice(0, 32);
}

function isValidSubscription(s) {
  return !!(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) &&
            s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');
}

// Apple 푸시 서버는 aes128gcm(RFC 8291)만 받는다. 구형 aesgcm으로 보내면 거부당한다.
let vapidKeyPairCache = null;
async function vapidKeyPair(env) {
  if (!vapidKeyPairCache) {
    vapidKeyPairCache = await deserializeVapidKeys({
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY
    });
  }
  return vapidKeyPairCache;
}

async function sendTo(sub, env, message) {
  const keyPair = await vapidKeyPair(env);
  return sendPushNotification(
    keyPair,
    { endpoint: sub.endpoint, keys: sub.keys },
    env.VAPID_CONTACT_EMAIL,
    JSON.stringify(message),
    { algorithm: 'aes128gcm', ttl: 6 * 60 * 60, urgency: 'normal' }
  );
}

// 구독이 죽으면 지운다. 그대로 두면 매일 헛발송한다.
// 404/410은 표준(RFC 8030), Apple은 400 BadWebPushToken을 주기도 한다.
async function sendAndPrune(key, sub, env, message) {
  try {
    const res = await sendTo(sub, env, message);
    let dead = res.status === 404 || res.status === 410;
    let reason = '';
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      reason = text.slice(0, 200);
      if (res.status === 400 && text.includes('BadWebPushToken')) dead = true;
    }
    if (dead) {
      await env.SUBS.delete(key);
      return { ok: false, status: res.status, reason, pruned: true };
    }
    return { ok: res.ok, status: res.status, reason };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

const REMINDER = {
  title: '오늘 하루를 짚어볼 시간',
  body: '1분이면 돼요. 지금 기록하기',
  url: 'https://nelly59290-source.github.io/mood-tracker/'
};

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/health') {
      const list = await env.SUBS.list({ prefix: 'sub:' });
      return json({ ok: true, subscriptions: list.keys.length }, 200, origin);
    }

    if (request.method !== 'POST') {
      return json({ error: 'not found' }, 404, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: '잘못된 JSON' }, 400, origin);
    }

    if (url.pathname === '/subscribe') {
      const sub = body.subscription;
      if (!isValidSubscription(sub)) return json({ error: '구독 정보가 올바르지 않아요' }, 400, origin);

      const key = await subKey(sub.endpoint);
      const existing = await env.SUBS.get(key);
      if (!existing) {
        const list = await env.SUBS.list({ prefix: 'sub:' });
        if (list.keys.length >= MAX_SUBS) {
          return json({ error: '등록 가능한 기기 수를 넘었어요' }, 429, origin);
        }
      }
      await env.SUBS.put(key, JSON.stringify({
        endpoint: sub.endpoint,
        expirationTime: sub.expirationTime ?? null,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        registeredAt: new Date().toISOString(),
        label: typeof body.label === 'string' ? body.label.slice(0, 40) : ''
      }));
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === '/unsubscribe') {
      if (typeof body.endpoint !== 'string') return json({ error: 'endpoint 필요' }, 400, origin);
      await env.SUBS.delete(await subKey(body.endpoint));
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === '/test') {
      if (typeof body.endpoint !== 'string') return json({ error: 'endpoint 필요' }, 400, origin);
      const key = await subKey(body.endpoint);
      const raw = await env.SUBS.get(key);
      if (!raw) return json({ error: '등록되지 않은 기기예요' }, 404, origin);
      const result = await sendAndPrune(key, JSON.parse(raw), env, {
        title: '테스트 알림',
        body: '이렇게 오면 성공이에요',
        url: REMINDER.url
      });
      return json(result, result.ok ? 200 : 502, origin);
    }

    return json({ error: 'not found' }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      const list = await env.SUBS.list({ prefix: 'sub:' });
      for (const k of list.keys) {
        const raw = await env.SUBS.get(k.name);
        if (!raw) continue;
        const result = await sendAndPrune(k.name, JSON.parse(raw), env, REMINDER);
        console.log('push', k.name, JSON.stringify(result));
      }
    })());
  }
};
