# trace

사용자가 선택한 환경에서 로컬 에이전트 세션을 읽고, 시각과 원본 파일·줄 번호를
포함한 공통 이벤트로 추출합니다.

저장소: [daily-plugins/trace](https://github.com/daily-plugins/trace).

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

도구는 `trace_activity` (default), `list_environments`, `list_local_sessions`, `extract_local_events`, `extract_git_activity`입니다.
통합 조회는 등록된 모든 소스를 사용하고 개별 조회에는 이름을 지정합니다. [도구 가이드](docs/tools.md)를 참고하세요.
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
자동 스캔은 `from` 이전에 마지막으로 수정된 로그를 제외하되, 조회 날짜 주변의
Codex 폴더는 유지합니다. 해당 날짜 파일을 먼저 읽고 최근 수정 파일을 이어 읽어,
과거에 시작했다가 조회 기간에 재개한 세션도 포함합니다. `scan`에 후보·제외·읽은
파일 수와 바이트 수를 반환합니다. 네이티브 로그가 추가될 때 수정 시각도 갱신된다는
전제입니다. 수정 시각을 보존한 가져오기·복원 기록은 `--scan-mode full`
(MCP: `scanMode: "full"`)로 조회하고 필요하면 루트를 좁혀 주세요.
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

## Git 파일 추적

에이전트 환경과 별도로 Git 작업 트리 루트를 등록합니다.

```sh
npm run trace -- setup-git --repository project --root /absolute/path/to/project
npm run trace -- git-activity --repository project \
  --from 2026-09-29T00:00:00+09:00 --to 2026-09-30T00:00:00+09:00
```

MCP 도구는 `extract_git_activity`입니다. HEAD에서 도달 가능한 일반 커밋의 이력과
변경 경로를 committer 시각 기준으로 조회합니다. `--include-working-tree`는 현재
추적/stage된 변경도 반환하지만 수정 시각을 모르므로 기간 필터를 적용하지 않습니다.
`--include-patch`로 제한된 diff를 포함합니다. 미추적 파일은 제외하고 백그라운드
수집이나 스냅샷 저장은 하지 않습니다. Git 2.37 이상이 필요합니다.
[제한 및 출력 의미](docs/tools.md#git-파일-활동)를 참고하세요.

지정한 상위 폴더 아래의 저장소를 자동으로 찾고 일괄 등록할 수 있습니다.

```sh
npm run trace -- discover-git --root /absolute/path/to/projects
npm run trace -- discover-git --root /absolute/path/to/projects --register
```

기본은 미리보기이며 `--register`를 붙이면 발견한 Git 작업 트리를 한 번의 설정 갱신으로
등록합니다. 기존 경로와 이름은 보존하고, 같은 폴더명은 숫자 접미사로 구분합니다.
`.git` 디렉터리와 worktree의 `.git` 파일을 모두 찾습니다. 일회성 탐색이며 상시 감시는
하지 않습니다. 터널에 등록하려면 `--config /path/to/config.json`으로 터널의 고정 설정
파일을 선택하세요. [탐색 제한](docs/tools.md#저장소-자동-탐색-cli)을 참고하세요.

## 기본 통합 조회

```sh
npm run trace -- --config .local/trace-config.json \
  --from 2026-09-29T00:00:00+09:00 --to 2026-09-30T00:00:00+09:00
```

명령 생략, `timeline`, 환경을 지정하지 않은 `extract`는 등록된 모든 에이전트 환경과
Git 저장소를 조회합니다. MCP 기본 도구는 `trace_activity`입니다. 날짜 생략 시 당일이
아닌 최근 24시간을 사용합니다. 이벤트는 시간 오름차순으로 합치고 현재 Git 변경은
별도로 반환합니다. 활동 없는 소스는 생략하며 조회 실패·제한 진단은 유지합니다.
`--no-working-tree`로 현재 변경을 제외합니다. 텍스트와 diff는 요청 시 포함합니다.
[통합 조회 의미](docs/tools.md#기본-통합-활동-조회)를 참고하세요.
