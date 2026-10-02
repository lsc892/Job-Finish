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

TypeScript 기반 VS Code 확장 MVP를 검증했습니다. 실제 에이전트 호출, 세션 로그 신호 수신, 창별 ID 구분을 테스트했으며 제품 버전을 개발하고 있습니다.

[검증용 MVP](tests/README.md)를 실행하거나 [테스트 결과](docs/VERIFICATION.md)를 확인할 수 있습니다.

## 라이선스

[MIT](README.md#license)
