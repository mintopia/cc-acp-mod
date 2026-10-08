# Changelog

## [0.3.0](https://github.com/mintopia/cc-acp-mod/compare/v0.2.0...v0.3.0) (2026-10-08)


### Features

* hold session/prompt open while background subagents run and forward subagent events with parentToolUseId ([25da66e](https://github.com/mintopia/cc-acp-mod/commit/25da66e354b191ba3dcc254ad98785ca8c0a75c4))
* hold the prompt for background subagents, forward subagent events ([ac06de9](https://github.com/mintopia/cc-acp-mod/commit/ac06de9ace51bed805d46bceebb945ab3f07015e))


### Bug Fixes

* submit Client prompts as the user's own words instead of a plugin message ([ad25b00](https://github.com/mintopia/cc-acp-mod/commit/ad25b00f38132e9df481d5013e808702cd24d5a8))

## [0.2.0](https://github.com/mintopia/cc-acp-mod/compare/v0.1.3...v0.2.0) (2026-10-08)


### Features

* session/set_model and finishing panel slash commands ([ef232f1](https://github.com/mintopia/cc-acp-mod/commit/ef232f1a7792d0479f98bd4f3c61a67e47a64c4d))
* support session/set_model, mapping full model ids to Claude Code's aliases ([b5f13bf](https://github.com/mintopia/cc-acp-mod/commit/b5f13bf8604673f57a7db191e14b9b8815813f06))


### Bug Fixes

* close panels opened by slash-command prompts so the prompt finishes, without interrupting /compact ([014eca2](https://github.com/mintopia/cc-acp-mod/commit/014eca2f2fe5d063b0957b4650023c5dcba120cc))

## [0.1.3](https://github.com/mintopia/cc-acp-mod/compare/v0.1.2...v0.1.3) (2026-10-08)


### Bug Fixes

* keep prompts in arrival order when an earlier prompt is still writing attachments ([c04a9eb](https://github.com/mintopia/cc-acp-mod/commit/c04a9eb53f24740862866b72a006805e6b058816))
* keep prompts in arrival order while attachments are written ([23df399](https://github.com/mintopia/cc-acp-mod/commit/23df3995c308ad762f830989cdad2a515d8b0ced))

## [0.1.2](https://github.com/mintopia/cc-acp-mod/compare/v0.1.1...v0.1.2) (2026-10-08)


### Bug Fixes

* run prompts that start with a slash command through $.command.run, which prompt.submit refuses ([9ec332a](https://github.com/mintopia/cc-acp-mod/commit/9ec332a6e782a5eb17468677d17299b8c9bc989b))
* run slash-command prompts through $.command.run ([9827f67](https://github.com/mintopia/cc-acp-mod/commit/9827f6797547f59da0d010c52c9bb504c20078ee))

## [0.1.1](https://github.com/mintopia/cc-acp-mod/compare/v0.1.0...v0.1.1) (2026-10-08)


### Bug Fixes

* ship the cc-acp bin as executable so installers that skip chmod can run it ([9cbebab](https://github.com/mintopia/cc-acp-mod/commit/9cbebabd47ee14ea6bd7ad0d546cbecaacbad659))
