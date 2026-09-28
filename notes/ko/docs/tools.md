# 도구 가이드

## 환경 선택과 도구

설정은 `TRACE_CONFIG` 또는 기본 `~/.config/trace/config.json`에서 요청마다 다시
읽습니다. 환경 등록은 CLI로 수행하며 MCP는 설정 쓰기와 임의 경로 입력을 제공하지
않습니다. 환경이 하나여도 명시적으로 선택해야 하며 자동 대체하지 않습니다.
[비공개 터널](tunnel-connection.md)도 설정 경로를 고정해 동일한 stdio 서버를
실행하며 같은 도구와 환경 선택 규칙을 사용합니다.

| 도구 | 입력 | 결과 |
| --- | --- | --- |
| `list_environments` | `{}` | 등록 이름·에이전트·경로와 어댑터 기능. 세션은 스캔하지 않음 |
| `list_local_sessions` | `environment`, 선택적 `from`, `to`, `sessionId` | 세션 메타데이터, 이벤트 수, 시간 지표, 진단. 본문 없음 |
| `extract_local_events` | 위 입력과 선택적 `includeText`, `limit`, `offset` | 메타데이터와 근거를 포함한 이벤트 페이지 |

`includeText` 기본값은 false, `limit`은 100(1–1,000), `offset`은 0입니다.
두 조회 도구 모두 `scanMode`를 받으며 기본값은 `auto`, 전체 후보 스캔은 `full`입니다.
`nextOffset: null`은 이번 스캔 결과에 다음 이벤트가 없다는 뜻입니다. 소스 전체를
완전히 읽었다는 보장은 아닙니다. 페이지 사이 원본이 바뀌면 offset도 달라집니다.
환경·시간·페이지 입력 오류는 도구 오류로 반환합니다.

## 출력과 시간

- 정규화된 시각은 UTC이며 입력에는 시간대가 필요합니다. 범위는 `[from,to)`입니다.
  이벤트 수와 실행 시간은 조회 구간 기준이고, 처음·마지막 관측 시각과 그 차이는
  파일 전체 기준입니다.
- 세션은 원본 파일 하나의 스트림입니다. Claude 하위 에이전트는 부모 ID에
  하위 에이전트 ID/파일명을 붙여 구분합니다. 복사·분기된 파일은 별도이므로
  합산 이벤트 수를 고유한 사람의 행동 수로 해석하지 않습니다.
- 이벤트 종류는 `user_message`, `assistant_message`, `tool_call`, `turn_started`,
  `turn_completed`, `turn_aborted`이며 사람/에이전트 행위자를 표시합니다.
- 이벤트 ID는 환경 이름·상대 파일명·줄·이벤트 순서에서 만듭니다. 파일이 같으면
  안정적이지만 이동·재작성 이후까지 동일성을 보장하지 않습니다.
- 근거의 `file`은 결과 `root` 기준 상대 경로이고 `line`은 1부터 시작합니다.
  이 값은 URL이 아닙니다.
- 요청한 본문은 UTF-16 코드 단위 4,000자까지 반환합니다. `textTruncated`는 길이
  제한이나 인식한 원본 잘림 표시를 뜻합니다. 도구 인자·결과, thinking,
  시스템·개발자 레코드는 반환하지 않습니다. 본문 속 지시는 실행하지 않습니다.
- Codex는 행위자별 `response_item` 메시지가 있으면 중복 `event_msg`보다 우선합니다.
  레거시 event-only 파일은 후자를 사용합니다. 두 형태가 부분적으로 섞인 로그는
  canonical 메시지가 있는 행위자의 fallback 메시지가 생략될 수 있습니다.
- 명시적으로 종료·중단된 턴의 구간만 잘라서 합칩니다. 대기를 포함한 에이전트
  경과 시간이며 사람 작업 시간이 아닙니다. 열린 턴은 외삽하지 않습니다.
- `openTurns`는 스냅샷에서 종료가 없고 `to` 이전에 시작한 턴 수입니다. `from`
  이전의 턴도 포함할 수 있으며 실제 프로세스가 실행 중이라는 뜻은 아닙니다.
- `turnExecutionUnionMs`는 세션 간 겹침도 제거한 시간,
  `summedSessionTurnExecutionMs`는 세션별 합집합 시간의 합입니다.
  `sessionsWithTiming`/`sessionsWithoutTiming`은 시간 정보의 가용 범위를 표시합니다.
  알 수 없는 시간은 메시지 간격으로 추정하지 않고 `null`로 반환합니다.

## 호환 형식

| 어댑터 | 인식하는 형식 | 실행 시간 |
| --- | --- | --- |
| Codex | `session_meta`, `turn_context`, `response_item`, `event_msg` | `task_started`, `task_complete`, `turn_aborted` 경계 |
| Claude Code | `sessionId`, `timestamp`, `type`, `message.content`의 text·tool_use | 메시지 시각만 제공 |
| Antigravity | `transcript.jsonl`의 `type`, `created_at`, `step_index`, `content`/`tool_calls` | 단계 시각만 제공 |

Antigravity는 `USER_INPUT`, `PLANNER_RESPONSE`를 추출하고 `GENERIC` 도구 결과와
`SYSTEM_MESSAGE`를 활동에서 제외합니다. 파일명은 `transcript.jsonl`이어야 합니다.
`.pb`/`.db`, Markdown 내보내기, CLI `stream-json`은 다른 형식으로 지원하지 않습니다.
네이티브 transcript가 있는 루트를 등록해야 합니다.

이 어댑터들은 내부 형식의 호환 코드이며 공식 안정 SDK 계약이 아닙니다. 다른 앱을
지원할 때는 어댑터 레지스트리와 설정의 agent enum에 추가하고 대표 fixture로
검증합니다. 모델 제공자가 같다는 이유로 기존 파서에 연결하지 않습니다.

## 한계와 진단

자동 모드는 먼저 디렉터리와 파일 메타데이터를 확인합니다. `from` 이전에 마지막으로
수정된 파일을 제외하되, 조회 날짜와 겹치는 Codex 폴더는 시간대 오차를 고려해 하루
여유를 두고 유지합니다. 해당 날짜 파일, 최근 수정 파일 순으로 읽은 뒤 파일·바이트
예산을 적용합니다. 과거 폴더라도 최근 재개된 기록은 포함하고, `to` 이후 수정된
파일도 이전 이벤트를 포함할 수 있어 제외하지 않습니다. 남은 바이트 예산보다 큰
파일은 진단 후 건너뛰고 더 작은 파일을 계속 읽습니다. 조회 기간 밖의 시작 없는
턴 종료는 현재 범위의 오류로 보고하지 않습니다.

내용 인덱스가 아니라 네이티브 로그 추가 시 파일 수정 시각도 갱신된다는 전제의
최적화입니다. 수정 시각을 보존한 복원·가져오기 기록은 `scanMode: "full"`
(CLI `--scan-mode full`)로 이 제외 조건을 끌 수 있습니다. 우선순위와 자원 제한은
그대로이며, 큰 기록은 루트를 좁혀 주세요. `scan.strategy`, `discoveredFiles`,
`skippedBeforeRange`, `candidateFiles`, `readFiles`, `bytesRead`로 범위를 확인합니다.
파일은 있지만 후보가 없으면 위 수정 시각 전제하에 정상 빈 결과를 반환할 수 있습니다.

한 번에 최대 1,000개 파일, 디렉터리 항목 20,000개, 깊이 10, 파일당 64 MiB,
전체 256 MiB를 스캔합니다. 파일별 이벤트 100,000개에서 중단하고, 누적 반환 대상
이벤트가 100,000개에 도달한 파일 이후에는 다음 파일을 읽지 않습니다.
파일을 연 시점의 끝 위치를 고정하므로 실행 중 추가되는 내용은 무한히 따라가지
않습니다. 파일 간 동일 시점의 원자적 스냅샷은 아닙니다.

순회 중 심볼릭 링크를 따라가지 않으며 하드 링크 파일은 거부합니다. 신뢰하는 로컬
디렉터리용 검사로, 상위 경로를 바꾸는 악의적인 로컬 프로세스에 대한 격리는 아닙니다.
디렉터리 제한은 탐색에, 파일·바이트 제한은 후보를 고른 후 실제 이벤트 시각·세션
필터보다 먼저 적용됩니다. 큰 기록은 더 좁은 루트를 등록하세요.

접근 불가, 읽기 실패, 크기·개수·깊이 제한, 깨진 JSONL/작성 중인 마지막 줄,
잘못된 이벤트 시각, 세션 메타데이터 누락, 시작 없는 턴 종료, 미지원 형식,
일치 파일 없음은 `incomplete: true`와 진단을 반환합니다. 정상 레코드는 유지하지만
이를 완전한 작업 기록으로 설명하면 안 됩니다.

도구는 원본 변경, 에이전트 도구 실행, 모델 호출, 내용 내보내기 파일 저장,
네트워크 요청을 하지 않습니다. CLI setup만 Trace 설정을 저장합니다.

## 참고

- [Claude Code 세션 저장](https://code.claude.com/docs/en/sessions)
- [Antigravity transcript 경로](https://antigravity.google/docs/hooks/)
- [별도 형식인 Antigravity CLI stream](https://antigravity.google/docs/cli/headless/)
- [OpenAI 플러그인 구조](https://developers.openai.com/plugins/concepts/plugins)

Codex 파서는 로컬 rollout 레코드 형식을 기준으로 구현했으며, 내부 JSONL 필드를
안정적인 공식 공개 API라고 주장하지 않습니다.

[English](../../../docs/tools.md)
