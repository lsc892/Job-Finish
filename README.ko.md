# Job-Finish

**[English](README.md) · 한국어 · [中文](README.zh.md) · [日本語](README.jp.md)**

Claude Code나 Codex의 응답이 끝나면, 하던 작업으로 돌아오세요.

Job-Finish는 에이전트의 신호를 해당 VS Code 창에 표시합니다. 여러 프로젝트를 오가면서도 어떤 작업의 응답이 도착했는지 확인할 수 있습니다.

![VS Code](https://img.shields.io/badge/platform-VS%20Code-0078D4)
![Status](https://img.shields.io/badge/status-verified%20MVP-orange)
![License](https://img.shields.io/badge/license-MIT-blue)

## 만들고 있는 기능

- VS Code 안에서 Claude Code와 Codex의 신호 확인.
- 같은 프로젝트를 여러 창에 열어도 창별로 결과 구분.
- 응답 완료 신호와 에이전트의 결과를 확인하는 화면.

## 현재 상태

TypeScript 기반 VS Code 확장 MVP로 실제 에이전트 호출, 세션 로그 신호 수신, 창별 ID 구분을 검증했습니다. 현재 저장소에는 소개 README, 개발 문서와 의사결정·검증 일지를 보관하며, 실행용 MVP와 테스트 파일은 정리했습니다.

[개발 문서](docs/requirements-and-verification.md)에는 기능·구현 알고리즘·완료 조건을, [일지](docs/일지.md)에는 선택 근거·과거 구현·실측 결과를 정리했습니다.

## 라이선스

[MIT](README.md#license)
