# 비공개 터널 연결

macOS/Linux에서 OpenAI Secure MCP Tunnel을 지원합니다. 공식 `tunnel-client`가
외부로 연결하고 로컬 Trace stdio 서버를 실행합니다. 별도 HTTP 서버나 외부 공개
수신 포트는 필요 없습니다. MCP 도구 세 개의 환경 선택 규칙은 그대로 유지되며,
요청받아 반환하는 세션 자료는 연결된 호스트로 전달됩니다.

## 준비

1. [공식 가이드](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)의
   다운로드 링크에서 터널 클라이언트를 설치합니다.
2. [Platform 터널 설정](https://platform.openai.com/settings/organization/tunnels)에서
   Trace 전용 터널을 만들고 워크스페이스를 연결합니다. 실행 키에는 Tunnels Read·Use,
   터널 생성에는 Read·Manage 권한이 필요합니다. Vault의 터널 ID·프로필을 재사용하지 않습니다.
3. [README](../README.md)에 따라 빌드하고 공개할 환경을 등록합니다. 등록만으로
   세션 추출이 시작되지는 않습니다.

```sh
npm ci
npm run build
```

`.env.tunnel`이 없을 때만 예시를 복사합니다.

```sh
cp .env.tunnel.example .env.tunnel
chmod 600 .env.tunnel
```

키는 채팅이나 Git에 넣지 않고 로컬 파일에서 편집합니다.

```dotenv
TRACE_TUNNEL_ID=tunnel_REPLACE_WITH_TRACE_TUNNEL_ID
CONTROL_PLANE_API_KEY=REPLACE_WITH_TRACE_RUNTIME_KEY
TRACE_TUNNEL_PROFILE=trace
# TRACE_CONFIG=/absolute/path/to/trace-config.json
# TUNNEL_CLIENT_PATH=/absolute/path/to/tunnel-client
```

`TRACE_CONFIG` 기본값은 `~/.config/trace/config.json`이며 파일이 존재해야 합니다.
연결 테스트에는 `version: 1`, `environments: []`인 빈 설정을 사용할 수 있습니다.
사용자가 환경을 등록하기 전에는 세션 경로가 노출되지 않습니다. 상대 경로는
Trace 저장소 기준으로 해석하며 `~/`를 확장합니다. 셸 변수가 `.env.tunnel`보다
우선합니다. `.env`와 `.env.http`는 읽지 않습니다. 클라이언트가 PATH에 있으면
`TUNNEL_CLIENT_PATH`는 생략할 수 있습니다.

## 초기화·검증·실행

```sh
npm run tunnel:init
npm run tunnel:doctor
npm run start:tunnel
# 같은 실행 명령: npm run remote
```

초기화는 공식 `sample_mcp_stdio_local` 템플릿으로 로컬 프로필을 만듭니다.
Node·부트스트랩·Trace 설정의 절대 경로를 고정합니다. API 키는 클라이언트 환경에만
전달하고 명령 문자열에 넣지 않으며, 부트스트랩은 MCP 서버를 불러오기 전에 키를
환경에서 제거합니다. 관리·상태 포트는 `127.0.0.1:0`으로 지정해 다른 플러그인과
충돌하지 않는 임의 포트를 사용합니다. 클라이언트가 출력하는 주소를 확인하세요.
이 관리 주소는 Trace MCP 엔드포인트가 아닙니다.

`start:tunnel`을 계속 실행하고 Ctrl+C로 종료합니다. 별도 `npm start`는 필요
없습니다. `tunnel:init`은 원격 터널 생성·권한 부여·기존 프로필 덮어쓰기를 하지
않습니다. 같은 이름의 프로필이 있으면 새 `TRACE_TUNNEL_PROFILE`을 쓰거나 공식
클라이언트의 프로필 갱신 절차로 의도적으로 수정합니다.
저장소·Node 위치, 터널 ID, 설정 파일 경로가 바뀌면 재초기화합니다. 기존 설정
파일의 내용만 바뀌면 MCP가 요청마다 읽으므로 재초기화할 필요가 없습니다.

## ChatGPT 연결

클라이언트를 실행한 상태로 개발자 모드 연결에서 **Connection → Tunnel**을 선택하고
Trace 터널을 지정합니다. 사용 가능 여부는 계정·워크스페이스 권한에 따릅니다.
먼저 `list_environments`를 호출하고, 등록한 환경을 골라 `list_local_sessions`나
`extract_local_events`를 사용합니다. 모든 경로를 자동으로 읽지 않습니다.

코드 변경 후에는 재빌드·재시작하고, 도구 변경 후에는 연결 메타데이터를 새로고침하고
새 대화를 시작합니다. 비공개 연결이며 공개 플러그인 배포가 아닙니다.
[공식 연결 가이드](https://developers.openai.com/plugins/deploy/connect-chatgpt)를 참고하세요.

## 문제 해결과 검증 범위

- 설정 없음: CLI setup을 실행하거나 `TRACE_CONFIG`에 기존 설정을 지정합니다.
- ID·키 없음: `.env.tunnel`을 수정합니다. 예시의 자리표시자는 거부됩니다.
- 클라이언트 없음: 공식 바이너리를 설치하거나 `TUNNEL_CLIENT_PATH`를 설정합니다.
- 프로필 중복: 기존 프로필을 보존하고 새 이름을 사용하거나 명시적으로 갱신합니다.
- 도구 검색 실패: 프로세스를 유지하고 `npm run tunnel:doctor`로 진단합니다.
  워크스페이스 연결과 키 권한도 확인합니다.
- 종료: Ctrl+C는 로컬 클라이언트를 멈춥니다. 연결을 영구 폐기할 때 원격 연결·키는
  별도로 제거하거나 폐기합니다.

자동 테스트는 가짜 클라이언트로 인자 인용, 프로필 선택, 환경변수 우선순위,
종료 코드와 시그널 전달을 검증합니다. 실제 로컬 MCP 연결로 고정 설정과 도구 검색도
검증하지만, 이것이 실제 터널 인증·ChatGPT 연결 성공을 뜻하지는 않습니다.
해당 계정으로 연결을 별도 확인해야 합니다.

[English](../../../docs/tunnel-connection.md)
