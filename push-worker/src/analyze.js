// 화이트보드 사진 → 운동기록 JSON.
// 앱이 직접 AI를 부르면 API 키가 공개 페이지에 노출된다. 그래서 Worker가 대신 부른다.
//
// 제공자는 갈아끼울 수 있다 (env.AI_PROVIDER):
//   gemini    → 무료 한도 있음 (기본값)
//   anthropic → 유료, 무료 한도가 없어지면 여기로
//
// 필요한 secret:
//   npx wrangler secret put GEMINI_API_KEY      (AI_PROVIDER=gemini 일 때)
//   npx wrangler secret put ANTHROPIC_API_KEY   (AI_PROVIDER=anthropic 일 때)

// 이번 시즌 화이트보드를 13장 읽으면서 쌓인 규칙이 전부 여기 들어있다.
// 표기가 또 바뀌면 이 프롬프트만 고치면 된다.
const PROMPT = `크로스핏 박스(Fox Gym)의 화이트보드 사진이다. "나현"의 기록만 뽑아 JSON으로 만들어라.

## 화이트보드 읽는 법

- 왼쪽/가운데에 그날 운동(WOD)이 적혀 있고, 오른쪽에 회원별 기록이 적혀 있다.
- **"나현"이 들어간 행만** 읽는다. 다른 회원의 기록과 이름은 절대 출력하지 않는다.
- 사진이 거울상이거나 뒤집혀 있을 수 있다. 그런 경우에도 글자를 바로 읽어라.

## 페어 판별

- 한 행에 이름이 **둘 이상이면 페어**, 하나면 솔로다.
- \`+\` 기호는 있을 때도 없을 때도 있다. \`나현 + 민서\`, \`나현 민서\` 둘 다 페어다.
- 3명인 경우도 있다(\`진화+승희+한나\`). 그때도 mode는 "pair"로 하고 partner에 나머지를 쉼표로 넣는다.
- **페어 기록의 시간/렙은 팀 공통 점수다.** 그대로 넣으면 된다.

## 중량 표기

- \`(105LB)\`처럼 기록 옆에 따로 오기도 하고, \`나현(40) + 민서(40)\`처럼 **이름 옆 괄호**에 오기도 한다.
  이름 옆 괄호면 그게 그 사람이 쓴 중량이다. 나현 것만 쓴다.
- \`(Rx'd)\`면 rx=true, 그보다 가벼운 중량을 썼으면 rx=false.
- 동작 옆 \`(225/155lb)\`는 처방 중량(rxWeight)이지 나현이 든 무게가 아니다.

## 점수 넣는 법 (중요)

- 완주했으면 시간 → \`time\` (\`"18:50"\`)
- **타임캡에 걸렸으면 시간 대신 총 렙 수** → \`reps\` (\`668\`), time은 null
- **AMRAP이면 완료한 라운드 수를 \`reps\`에** 넣는다 (\`12R\` → reps: 12)
- 인터벌 종목은 시간과 렙이 **둘 다** 적히기도 한다. 있으면 둘 다 넣어라.

## 하루에 종목이 여러 개일 수 있다

- \`AMRAP 12min\`이 세 번 적혀 있으면 pieces 배열에 3개를 넣는다. 하나로 합치지 마라.
- \`[STRENGTH]\` 같은 제목이 붙은 블록은 strength에 넣는다.

## 출력 형식

이 JSON만 출력해라. 설명 금지.

{
  "pieces": [
    {
      "format": "for-time" | "amrap" | "emom" | "interval" | null,
      "rounds": 정수 또는 null,
      "movements": [{"reps": 정수 또는 생략, "name": "영문 동작명", "rxWeight": "225/155lb" 또는 생략}],
      "time": "18:50" 또는 null,
      "reps": 정수 또는 null,
      "weight": 숫자 또는 null,
      "unit": "lb" | "kg" | null,
      "rx": true | false | null
    }
  ],
  "strength": {"movement": "Front Squats", "scheme": "5x5 @80%"} 또는 null,
  "mode": "solo" | "pair" | null,
  "partner": "민서" 또는 null,
  "note": "타임캡·인터벌 조건 등 특이사항 한 줄. 없으면 빈 문자열",
  "confidence": "high" | "low",
  "unreadable": ["읽지 못한 항목 설명"]
}

## 추측 금지

흐리거나 가려져서 확신이 없으면 **그 값을 null로 두고** unreadable에 무엇을 못 읽었는지 적어라.
그럴듯한 숫자를 지어내지 마라. 못 읽은 건 사람이 채우면 된다.
나현의 행 자체를 못 찾으면 confidence를 "low"로 하고 unreadable에 그렇게 적어라.`;

async function callGemini(env, base64, mime) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data: base64 } }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0 }
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini가 빈 응답을 줬어요');
  return text;
}

async function callAnthropic(env, base64, mime) {
  const model = env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: base64 } },
          { type: 'text', text: PROMPT }
        ]
      }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data?.content?.find(c => c.type === 'text')?.text;
  if (!text) throw new Error('Anthropic이 빈 응답을 줬어요');
  return text;
}

// 모델이 ```json 펜스를 붙여 보내는 경우가 있다.
function parseModelJson(text) {
  let t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

// 이 Worker는 인증이 없다. 엔드포인트가 알려져도 피해가 한도 안에서 멈추도록 하루 상한을 둔다.
const DAILY_LIMIT = 40;

async function checkRateLimit(env) {
  const key = `rl:analyze:${new Date().toISOString().slice(0, 10)}`;
  const used = parseInt((await env.SUBS.get(key)) || '0', 10);
  if (used >= DAILY_LIMIT) return false;
  // 48시간 뒤 자동 삭제 (KV 최소 TTL이 60초라 넉넉히 준다)
  await env.SUBS.put(key, String(used + 1), { expirationTtl: 172800 });
  return true;
}

const MAX_BASE64 = 6 * 1024 * 1024; // 원본 그대로 올리는 걸 막는다. 앱이 축소해서 보낸다.

export async function handleAnalyze(body, env) {
  if (typeof body.image !== 'string' || !body.image) {
    return { status: 400, payload: { error: '사진이 없어요' } };
  }
  if (body.image.length > MAX_BASE64) {
    return { status: 413, payload: { error: '사진이 너무 커요. 앱을 최신으로 새로고침해 주세요.' } };
  }
  const mime = typeof body.mime === 'string' && body.mime.startsWith('image/') ? body.mime : 'image/jpeg';

  if (!(await checkRateLimit(env))) {
    return { status: 429, payload: { error: '오늘 사진 분석 한도를 다 썼어요. 내일 다시 시도해 주세요.' } };
  }

  const provider = env.AI_PROVIDER || 'gemini';
  try {
    const text = provider === 'anthropic'
      ? await callAnthropic(env, body.image, mime)
      : await callGemini(env, body.image, mime);
    const parsed = parseModelJson(text);
    if (!Array.isArray(parsed.pieces)) parsed.pieces = [];
    return { status: 200, payload: { ok: true, provider, workout: parsed } };
  } catch (e) {
    console.log('analyze failed', e.message);
    return { status: 502, payload: { error: '사진을 읽지 못했어요: ' + e.message } };
  }
}
