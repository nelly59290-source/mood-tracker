# push-worker

저녁 리마인더 푸시를 보내는 Cloudflare Worker.

iOS 웹앱은 스스로 알림을 예약할 수 없다. 웹 푸시는 반드시 외부에서 쏴야 하고,
그래서 이 Worker가 매일 20:00 KST에 cron으로 발송한다.

## 배포 정보

| 항목 | 값 |
|---|---|
| Worker URL | https://mood-tracker-push.nelly59290.workers.dev |
| Cloudflare 계정 | nelly59290@gmail.com |
| KV 네임스페이스 | `SUBS` (id는 `wrangler.toml`) |
| cron | `0 11 * * *` (= 20:00 KST) |
| 비용 | 무료 (하루 요청 1건, 무료 한도 100,000건) |

## 엔드포인트

| | 용도 |
|---|---|
| `POST /subscribe` | 구독 등록 (앱에서 알림 켤 때) |
| `POST /unsubscribe` | 구독 해제 |
| `POST /test` | 즉시 한 번 발송 |
| `GET /health` | 등록된 구독 수 확인 |

## 자주 할 작업

### 상태 확인

```bash
curl -s https://mood-tracker-push.nelly59290.workers.dev/health
```

### 실시간 로그

```bash
npx wrangler tail
```

cron 발송 결과가 `push sub:xxx {...}` 형태로 찍힌다.

### 알림 시간 변경

`wrangler.toml`의 cron을 고치고 재배포한다. **UTC 기준이라 KST에서 9시간을 빼야 한다.**

| 원하는 시간 (KST) | cron |
|---|---|
| 20:00 | `0 11 * * *` |
| 20:30 | `30 11 * * *` |
| 21:00 | `0 12 * * *` |
| 19:00 | `0 10 * * *` |

```bash
npx wrangler deploy
```

### 알림 문구 변경

`src/index.js`의 `REMINDER` 상수를 고치고 재배포.

## 비밀값

`wrangler.toml`에 두지 않고 Cloudflare secret으로 관리한다 (저장소가 공개라서).

```bash
npx wrangler secret put VAPID_PRIVATE_KEY < .vapid-private-key.txt
npx wrangler secret put VAPID_CONTACT_EMAIL
```

- `VAPID_PRIVATE_KEY` — 푸시 서명용 개인키. `.vapid-private-key.txt`는 git 제외
- `VAPID_CONTACT_EMAIL` — 애플이 발송자 식별용으로 요구하는 연락처

개인키를 잃어버리면 새로 만들고 `index.html`의 `VAPID_PUBLIC_KEY`도 같이 바꿔야 하며,
기존 구독은 전부 무효가 되어 기기에서 알림을 다시 켜야 한다.

## 설계 메모

**Apple은 aes128gcm(RFC 8291)만 받는다.** 구형 `aesgcm` 인코딩으로 보내면 거부당한다.
처음 쓰려던 `@block65/webcrypto-web-push`가 구형을 내보내서 `web-push-browser`로 교체했다.
라이브러리를 다시 바꿀 일이 있으면 `Content-Encoding: aes128gcm` 과
`Authorization: vapid t=..., k=...` 형식인지 반드시 확인할 것.

**디버깅 팁**: 가짜 엔드포인트로 발송했을 때 애플이 주는 응답으로 원인을 구분할 수 있다.

| 응답 | 의미 |
|---|---|
| `400 BadWebPushToken` | VAPID는 정상, 기기 토큰만 잘못됨 |
| `403 InvalidProviderToken` | VAPID 키/서명 문제 |

**죽은 구독 정리**: 404 / 410 / `400 BadWebPushToken`이면 KV에서 지운다.
안 지우면 매일 헛발송한다.

**인증 없음**: 공개 앱이라 클라이언트에 숨길 비밀이 없어서 `/subscribe`에 인증을 두지 않았다.
대신 구독 수를 `MAX_SUBS = 10`으로 제한해 대량 등록을 막는다.

**서비스워커 주의**: 앱의 `service-worker.js`가 이 Worker 도메인(`.workers.dev`)을
캐시하지 않도록 우회 처리돼 있다. 캐시되면 옛 응답을 계속 읽게 된다.
