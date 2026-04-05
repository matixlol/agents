# codex-fast-mode

Experimental Pi extension for the `openai-codex` provider.

## What it does

- injects `service_tier: "priority"` into Codex requests when enabled
- adds `/codex-fast` commands to toggle the override
- remembers the last enabled/tier state across Pi runs
- shows `fast:priority` in the bottom-right footer next to the model/thinking indicator

## Install from git

```bash
pi install git:github.com/matixlol/agents
```

Or try it without installing:

```bash
pi -e git:github.com/matixlol/agents --codex-fast --model openai-codex/gpt-5.4-mini
```

## Usage

If the extension is loaded directly with `-e`, you can use the CLI flag:

```bash
pi -e git:github.com/matixlol/agents --codex-fast --model openai-codex/gpt-5.4-mini
```

If the package is already installed, enable it once with the slash command and the extension will remember it across future runs:

```bash
pi --model openai-codex/gpt-5.4-mini
# then inside pi:
/codex-fast on
```

You can still override startup state from the shell when needed:

```bash
PI_CODEX_FAST=1 pi --model openai-codex/gpt-5.4-mini
PI_CODEX_FAST=0 pi --model openai-codex/gpt-5.4-mini
```

Runtime controls:

- `/codex-fast`
- `/codex-fast on`
- `/codex-fast off`
- `/codex-fast toggle`
- `/codex-fast priority`
- `/codex-fast status`

## Notes

- This is not an official Pi feature.
- The extension persists its last state in `~/.pi/agent/codex-fast-mode.json`.
- CLI/env overrides still win for the current startup.
- The ChatGPT Codex backend accepts `priority` but rejected `flex` during testing.
- The extension only affects the `openai-codex` provider.
- `PI_CODEX_FAST_TIER` is supported, but currently only `priority`/`fast` are valid values.
