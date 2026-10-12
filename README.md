# Auto Cartographer v1.0.0

Auto Cartographer automates Cartography dig-site map progression in Melvor Idle.

## Features

- Continues upgrading non-Perfect maps at the current dig site.
- Moves on to the next discovered/unlocked dig site when the current one is complete.
- Automatically creates missing dig-site maps using vanilla map-creation costs.
- Automatically switches to Paper Making when Paper is required, then returns to the exact interrupted map.
- Survives save/reload while an automatic Paper refill is in progress, including cases where Cartography restores as stopped.
- Configurable Paper log priority with enable/disable controls and fallback between enabled log types.
- Works during online and offline progression.
- Reports Auto Cartographer actions in the normal offline recap, including:
  - cross-site movement;
  - created maps;
  - Paper-making refill cycles;
  - Paper log fallback changes;
  - map upgrade counts and tier improvements for maps vanilla would otherwise omit.

## Settings

### General

- **Enable Auto Cartographer** — enables/disables automation.
- **Automatically create missing maps** — fills empty map slots using normal vanilla costs.

### Paper Production

- **Automatically make Paper when required** — temporarily switches to Paper Making when needed.
- **Paper to make per refill** — default **1000**. Changes apply to an in-progress refill.
- **Paper log priority** — configure the ordered fallback list of Normal, Oak, Teak, Mahogany, Maple, Yew and Magic Logs, with individual log types optionally disabled.

## Notes

Auto Cartographer treats Paper Making that it started as a managed temporary action. That recovery instruction persists across logins until the interrupted map is resumed. If the player deliberately changes Cartography to another active action, Auto Cartographer yields control rather than hijacking it.

For Creator Toolkit/local development builds, a browser-local fallback is used alongside `characterStorage` so managed Paper recovery and Paper-log configuration survive the local-mod save-loading behaviour observed during development.

## Release

v1.0.0 is the first release candidate promoted from the tested v0.3.15 build. The automation engine is the proven v0.3.12 state machine; later development changed reporting only. The release default for Paper refills has been restored from the temporary test value of 100 to **1000**.
