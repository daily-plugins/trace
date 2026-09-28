# trace

사용자가 선택한 환경에서 로컬 에이전트 세션을 읽고, 시각과 원본 파일·줄 번호를
포함한 공통 이벤트로 추출합니다.

## 지원하는 소스

| 에이전트 | 세션 루트 예시 | 추출 내용 |
| --- | --- | --- |
| Codex | `~/.codex/sessions` | Rollout JSONL의 메시지, 도구 이름, 명시적인 턴 시작·종료 |
| Claude Code | `~/.claude/projects` | Transcript JSONL의 메시지, 도구 이름, 하위 에이전트 |
| Antigravity | `~/.gemini/antigravity/brain`, `~/.gemini/antigravity-cli/brain`, `~/.gemini/antigravity-ide/brain` | `.system_generated/logs/transcript.jsonl`의 사용자·플래너 메시지와 도구 이름 |

모델 제공자가 아니라 세션을 저장하는 앱으로 구분합니다. Antigravity에서 Claude
모델을 사용해도 Antigravity 어댑터를 선택합니다. 한 환경은 에이전트 한 종류와
루트 한 곳을 등록하며, 설치 위치가 여럿이면 환경을 각각 등록합니다.
예시 경로를 자동으로 스캔하지 않습니다.

Transcript가 없는 구형 Antigravity `.pb`/`.db`, Claude 웹·데스크톱 내보내기,
임의의 API 로그는 지원하지 않습니다. 내부 기록 형식은 버전에 따라 달라질 수
있으며, [도구 가이드](docs/tools.md)에 명시된 형태를 지원합니다.

## 시작하기

Node.js 20.20 이상이 필요합니다.

```sh
npm ci
npm run build
npm run trace -- agents
```

사용할 소스와 실제 존재하는 세션 경로만 등록합니다.

```sh
npm run trace -- setup --environment work-codex --agent codex --root ~/.codex/sessions
npm run trace -- setup --environment work-claude --agent claude-code --root ~/.claude/projects
npm run trace -- setup --environment work-agy --agent antigravity --root ~/.gemini/antigravity-cli/brain
```

등록은 Trace 설정만 저장하며 세션 추출이나 에이전트 설정 변경을 하지 않습니다.
기본 설정은 `~/.config/trace/config.json`입니다. `TRACE_CONFIG` 또는 CLI의
`--config /absolute/path/config.json`으로 변경할 수 있습니다. 기존 이름을
수정하려면 `--replace`가 필요합니다. 다른 환경으로 자동 대체하지 않습니다.

```sh
npm run trace -- environments
npm run trace -- sessions --environment work-agy
npm run trace -- extract --environment work-codex \
  --from 2026-09-28T00:00:00+09:00 --to 2026-09-29T00:00:00+09:00 \
  --include-text --limit 100
```

조회 구간은 시작을 포함하고 끝을 제외합니다. 시간대를 명시해야 합니다.
본문은 `--include-text`로 요청할 때만 이벤트당 최대 4,000자까지 반환합니다.
다음 페이지는 `nextOffset`을 사용합니다. 순수 JSON을 파일로 보내려면
`node dist/src/cli.js extract ...` 또는 `npm run --silent trace -- ...`를 사용합니다.
종료 코드는 정상 0, 잘못된 요청·설정 1, 불완전한 추출 2입니다.

## MCP 연결

`npm start`와 `npm run start:stdio`는 동일한 로컬 stdio 서버를 실행합니다.
표준 출력은 MCP 프로토콜 전용입니다. MCP 클라이언트 설정 예시는 다음과 같습니다.

```json
{
  "mcpServers": {
    "trace": {
      "command": "node",
      "args": ["/absolute/path/to/trace/dist/src/server.js"],
      "env": { "TRACE_CONFIG": "/absolute/path/to/trace-config.json" }
    }
  }
}
```

도구는 `list_environments`, `list_local_sessions`, `extract_local_events`입니다.
추출 시 환경 이름을 반드시 지정합니다. [도구 가이드](docs/tools.md)를 참고하세요.
스킬과 개발용 매니페스트가 포함되어 있으며, 빌드 후 MCP를 직접 연결합니다.
마켓플레이스 자동 설치와 HTTP는 아직 구현하지 않았습니다.
비공개 터널은 `npm run tunnel:init`, `npm run tunnel:doctor`,
`npm run start:tunnel`로 실행하며 `npm run remote`도 같은 실행 명령입니다.
클라이언트·프로필·실행 키는 [터널 가이드](docs/tunnel-connection.md)를 참고하세요.
로컬 추출 자체에는 계정 인증정보나 모델 API 키가 필요하지 않습니다.

## 시간의 의미

- `observedSpanMs`: 파일 전체에서 인식한 첫 시각과 마지막 시각의 차이입니다.
  비활동 구간을 포함하므로 작업 시간으로 해석하지 않습니다.
- `turnExecutionMs`: 종료·중단된 Codex 턴의 명시적 구간을 조회 범위에 맞춰 잘라
  겹침을 제거한 시간입니다. 대기 시간을 포함할 수 있고 사람의 집중 시간이나
  모델의 순수 연산 시간이 아닙니다. 종료되지 않은 턴은 외삽하지 않습니다.
- Claude Code·Antigravity와 턴 경계가 없는 구형 Codex의 실행 시간은 `null`입니다.
- 전체 구간의 합집합과 세션별 시간의 합을 따로 제공합니다. 실행 시간 정보가
  있는 세션과 없는 세션의 수로 측정 범위를 확인할 수 있습니다.

## 구조와 한계

`config.ts`가 환경을 선택하고 `adapters.ts`가 형식을 해석합니다.
`extractor.ts`가 읽기 전용 스냅샷을 스캔해 시간 정규화·구간 계산·페이지 처리를
수행하며 CLI와 MCP가 같은 엔진을 사용합니다.

원본을 수정하거나 네트워크 요청을 보내거나 내용 DB를 만들지 않습니다.
MCP로 본문을 반환하면 연결된 호스트가 그 내용을 받게 됩니다. 본문에서 임의의
비밀정보를 제거해 주는 기능은 아닙니다. 도구 인자·출력, thinking 블록,
시스템·개발자 메시지는 제외합니다. 대화 본문은 신뢰할 수 없는 분석 자료입니다.

스캔 한계에 도달하면 `incomplete`와 `diagnostics`를 확인해야 합니다.
예전에 시작한 세션의 재개를 찾기 위해 파일명 날짜로 스캔을 제외하지 않습니다.
상세 제한은 도구 가이드에 있습니다. 백그라운드 수집, 영속 인덱스, 원격 세션,
이메일·브라우저 연동, 자동 요약은 아직 구현하지 않았습니다.

```sh
npm run typecheck
npm test
```

테스트는 임시 합성 데이터로 실행하며 CLI와 MCP 연결도 검증합니다.
Codex·Antigravity는 로컬 기록 형식을 확인했고, Claude Code는 이 환경에서 실제
설치본을 검증하지 못했으므로 합성 fixture 검증 범위입니다.

[English](../../README.md)
