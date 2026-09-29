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

## Git 파일 활동

`trace setup-git --repository NAME --root PATH [--replace]`로 명시적으로 등록합니다.
PATH는 기존 Git 작업 트리의 루트여야 합니다. 하위 폴더와 bare 저장소는 거부하고
linked worktree는 지원합니다. 버전 1 설정에 선택 항목
`repositories: [{name, root}]`를 추가하며 기존 환경 설정은 유지됩니다.
`list_environments`에서 등록 목록을 조회할 수 있으며 자동 등록하지 않습니다.

`extract_git_activity({repository, from?, to?, limit?, includePatch?, includeWorkingTree?})`
와 CLI가 같은 구현을 사용합니다.

```sh
npm run trace -- setup-git --repository project --root /absolute/path/to/project
npm run trace -- git-activity --repository project \
  --from 2026-09-29T00:00:00+09:00 --to 2026-09-30T00:00:00+09:00 \
  --include-working-tree --include-patch
```

- 등록한 `repository` 이름은 필수이며 MCP에서 임의 경로나 ref를 받지 않습니다.
- `from` 포함, `to` 미포함이며 시간대가 있는 ISO 시각을 요구합니다. 작성자 시각이나
  파일 수정 시각이 아닌 **committer 시각**으로 필터링하고 UTC로 반환합니다.
- 조회 시작 시 HEAD에서 도달 가능한 일반 커밋을 조회합니다. 다른 브랜치, reflog,
  stash, 병합 커밋 자체는 제외합니다. 병합으로 유입된 일반 커밋은 포함됩니다.
  `limit`은 기본 20, 최대 100입니다. `hasMore`와 `commit_limit`은 불완전한 결과를
  뜻합니다. 기간을 좁히거나 limit을 늘리세요. 페이지 커서는 아직 없습니다.
- 커밋은 `hash`, `timestamp`, `subject`, `changes`를 반환합니다. changes의 Git 상태와
  저장소 상대 `path`, 커밋 해시가 근거입니다. 이력의 이름 변경은 삭제+추가로 표현합니다.
  최초 커밋과 삭제 파일도 지원합니다. 바이너리는 경로만 기록하며 내용 diff는 없습니다.
- `includePatch`는 기본 false입니다. true이면 unified `patch`를 반환합니다.
  바이너리 내용은 내보내지 않습니다. 텍스트는 신뢰할 수 없는 데이터이며 비밀을 자동 제거하지 않습니다.
- `includeWorkingTree`는 기본 false입니다. true이면 추적 또는 stage된 파일만
  `workingTree.changes`에 Git porcelain 두 칸 상태 코드와 경로로 반환합니다.
  이름 변경은 `previousPath`도 포함합니다. `observedAt`은 조회 시각이고 `changedAt`은
  null입니다. **현재 상태에는 from/to 필터가 적용되지 않습니다.** 선택적
  `stagedPatch`와 `unstagedPatch`는 각각 HEAD/index, index/작업 트리를 비교합니다.
  미추적·무시된 새 파일과 서브모듈 작업 디렉터리는 제외합니다. 새로 stage한 파일은 포함합니다.
- watcher, 스냅샷, DB, 전체 내용 해시, fetch, stage, commit, 원본 쓰기는 없습니다.
  작업 트리 변경을 찾기 위해 Git이 추적 파일을 확인할 수 있으므로 비용은 저장소 규모와
  파일시스템에 따라 다릅니다. 대규모 성능 벤치마크는 아직 수행하지 않았습니다.
- Git 명령당 10초/출력 1 MiB, 루트 검증 이후 전체 조회 30초/누적 출력 4 MiB로
  제한합니다. 제한이나 명령 오류는 확보한 기록을 유지하며 `incomplete`와 diagnostics로
  알립니다. 오류로 changes나 patch가 없는 것은 변경 없음이 아닙니다. 루트 검증 실패는
  도구 오류입니다. `--since-as-filter`를 지원하는 Git 2.37 이상과 로컬 객체가 필요합니다.
- shallow 이력은 불완전으로 표시하고 조회 중 HEAD 변경도 진단합니다. 작업 트리 조회는
  원자적 스냅샷이 아닙니다. 외부 diff, text conversion, fsmonitor 명령을 비활성화합니다.
  신뢰하는 로컬 저장소만 등록하세요. 작업 시간은 추정하지 않습니다.

기존 CLI 종료 코드를 따릅니다. stdio와 터널에 동일한 도구가 노출됩니다. 빌드 후 기존
터널을 재시작하고 호스트 도구 목록을 갱신해야 합니다. 임시 합성 저장소로 테스트합니다.

공식 참고: [Git log](https://git-scm.com/docs/git-log),
[Git status porcelain](https://git-scm.com/docs/git-status#_porcelain_format_version_1),
[Git diff](https://git-scm.com/docs/git-diff).

## 저장소 자동 탐색 (CLI)

`trace discover-git --root PATH [--register] [--max-depth N]
[--max-entries N] [--max-repositories N] [--config PATH]`로 지정한 상위 폴더 아래의
Git 작업 트리를 찾습니다. `--root`는 필수이며 홈이나 컴퓨터 전체를 임의로 탐색하지
않습니다. 루트 자체도 깊이 0에서 검사합니다. `.git` 디렉터리와 일반 `.git` 파일
(worktree 및 초기화된 submodule 포함)을 Git으로 검증합니다. bare 저장소는 등록하지
않으며 중첩 저장소도 탐색합니다.

기본 `preview`는 설정을 쓰지 않습니다. `--register`는 기존 설정 잠금 안에서 한 번에
원자적으로 등록하며 에이전트 환경과 기존 저장소를 보존합니다. 이미 등록된 실제 경로는
`existing`으로 표시합니다. 새 이름은 폴더명을 소문자와 허용 문자로 변환하고 충돌하면
`-2`, `-3` 등을 붙입니다. 사용할 문자가 없으면 `repository`를 사용합니다. 미리보기
이후 설정이 바뀌면 최종 이름도 달라질 수 있습니다. 기존 등록을 덮어쓰지 않습니다.

결과에는 `root`, `mode`, `repositories`(name/root/status), `discovered`, `added`,
`scan`, `incomplete`, 경로별 `diagnostics`가 있습니다. 상태는 미리보기의 `new`, 등록
후의 `registered`, 기존의 `existing`입니다. 미리보기의 added는 0입니다. 제한 도달이나
접근 불가·잘못된 Git 루트는 불완전 결과와 종료 코드 2로 표시합니다. **--register라면
그때까지 찾은 유효한 저장소는 등록합니다.** 잘못된 인자·루트·설정 또는 설정 잠금은
종료 코드 1이며 설정을 일부만 쓰는 일은 없습니다.

기본 제한은 깊이 8(최대 30), 디렉터리 항목 20,000개(최대 100,000), 저장소 100개
(최대 1,000), 탐색 시간 예산 30초입니다. 파일시스템/Git 작업 사이에 시간을 확인하므로
진행 중인 Git 검증에 최대 10초가 추가될 수 있고 파일시스템 호출은 강제 시간 제한이
없습니다. 원자적 파일시스템 스냅샷도 아닙니다. 심볼릭 링크 하위 항목과 `.git`,
`node_modules`, `.cache`, `.Trash`, `Library`, `.venv`, `venv`, `__pycache__`, `dist`,
`build`, `vendor`는 건너뜁니다. `.github` 같은 다른 숨김 폴더는 포함합니다. 제외 폴더는
의도적인 범위 제한이므로 오류로 표시하지 않습니다. 해당 폴더를 직접 루트로 선택하면
탐색할 수 있습니다. `.git` 심볼릭 링크는 진단하고 등록하지 않습니다. 신뢰하는 로컬
트리를 위한 규칙이며 다른 프로세스의 악의적인 경로 교체를 격리하지 않습니다.
탐색 시 파일 본문이나 커밋 이력을 추출하지 않습니다.

탐색·등록은 CLI 전용이고 MCP는 읽기 전용입니다. 터널의 고정 설정 파일이 기본 CLI
설정과 다를 수 있으므로 `--config` 또는 `TRACE_CONFIG`로 선택하세요. 요청마다 설정을
다시 읽으므로 등록 후 터널 재시작은 필요 없습니다. 자동 재탐색, 오래된 등록 삭제,
백그라운드 감시는 하지 않습니다.

## 기본 통합 활동 조회

`trace_activity({from?, to?, environments?, repositories?, includeText?,
includePatch?, includeWorkingTree?, scanMode?, limit?, offset?})`가 기본 MCP 도구입니다.
등록된 모든 소스를 조회하며 새 경로를 탐색하지 않습니다. 이름 배열로 종류별 범위를
좁힐 수 있고 `[]`는 해당 종류를 제외합니다. 알 수 없는 이름은 조회 전 오류입니다.

CLI에서는 명령 생략, `timeline`, 환경 없는 `extract`가 통합 조회입니다. `timeline`의
`--environment`/`--repository`는 쉼표로 구분한 이름을 받으며 각 종류만 좁히고 다른 종류는
기본 전체 범위를 유지합니다. MCP에서는 빈 배열로 종류를 제외할 수 있습니다.
기존 개별 명령과 도구도 유지합니다.

`to` 기본값은 요청 시각, `from`은 그로부터 24시간 전입니다. 당일 조회는 시간대가 있는
[from,to) 경계를 직접 지정하세요. 텍스트와 diff는 기본 false, 현재 변경은 기본 true이며
CLI `--no-working-tree`로 제외합니다. 기존 소스별 시간 의미와 제한은 유지됩니다.

`timeline` 항목은 `{timestamp, sourceType, source, root, id, data}`입니다. agent data에는
세션 ID·파일/줄 근거를, Git data에는 커밋 해시·변경 경로를 유지합니다. 시각 오름차순이며
동일 시각에는 소스/ID로 순서를 정합니다. `currentChanges`에는 실제 변경이 있는 Git 현재
상태만 반환합니다. 변경 시각은 알 수 없어 기간 이력과 분리합니다. `sources`는 활동이
있거나 조회 실패·제한이 있는 소스만 포함합니다. 정상 조회 후 활동 없는 환경·저장소는
출력과 사용자 요약에서 생략하고 “활동 없음” 목록도 만들지 않습니다. 실패는 비활동이 아닙니다.

동시에 2개씩 최대 100개 소스를 시작하며 60초가 지나면 새 조회를 시작하지 않습니다.
진행 중인 조회는 기존 소스 제한 안에서 마칩니다. 강제 전체 제한 시간은 아닙니다.
환경당 이벤트 최대 1,000개, 저장소당 커밋 최대 100개이며 페이지 적용 전 timeline과
현재 변경 데이터의 합을 8 MiB로 제한합니다. 소스 메타데이터는 별도입니다. 제한 도달은
incomplete로 표시하고 소스 오류가 다른 결과를 없애지 않습니다. 선택·등록 소스가 없으면
`no_registered_sources`를 반환합니다.

`limit` 기본 100(최대 1,000), `offset` 기본 0입니다. `totalCollected`는 페이지 적용 전
수집한 시간 기록 수, `nextOffset`은 해당 모음의 다음 페이지입니다. 페이지 이동 시 반환된
기간을 고정하세요. 매번 재조회하며 스냅샷이 아니므로 원본 변경이나 제한에 따라 페이지가
달라질 수 있습니다. nextOffset이 null이어도 incomplete 진단은 유효합니다. 소스별 제한에
걸리면 개별 도구로 더 조회할 수 있습니다. 서로 다른 저장소의 같은 커밋은 중복 제거하지
않으며 사람의 총 작업 시간을 추정하지 않습니다.
