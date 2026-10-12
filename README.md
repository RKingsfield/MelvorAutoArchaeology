# Auto Archaeology v1.0.0

Companion mod for Auto Cartographer.

Initial stable release after multi-day offline stress testing of all three automation modes.

## Modes

Auto Archaeology uses a single **Mode** dropdown:

- **Discovery** — hunt permanently undiscovered Archaeology items and enable only the Tiny / Small / Medium / Large tools that can still find something new.
- **Restock** — farm selected Archaeology consumables until all usable charged maps at their source sites are exhausted.
- **Use All Maps** — burn every charged Archaeology map across all available dig sites.

**Discovery is the default mode.** Restock starts with no items selected so it is always an explicit opt-in.

## Discovery

Discovery uses Melvor's permanent discovery statistic (`game.stats.itemFindCount(item)`) rather than current bank contents. It:

- enables only artefact sizes containing something still undiscovered;
- disables a size as soon as that category is complete;
- leaves remaining map charges untouched when a site becomes discovery-complete;
- skips already-complete sites;
- circles the full dig-site list before deciding no eligible work remains.

## Restock

The Restock target list is generated from the live Archaeology drop tables. Only Archaeology drops whose item type is `Consumable` are offered.

For selected targets, Restock:

- enables only artefact sizes that can drop a selected item;
- farms every eligible charged source site;
- wraps through the full dig-site list before stopping;
- reports net bank gains per selected target and which source sites need more maps.

## Use All Maps

Use All Maps deliberately ignores discovery and target filtering. It:

- consumes every charged map at the current site;
- moves through every available Archaeology site;
- wraps from the end of the list back to the beginning;
- stops only after one full circular pass finds no charged maps anywhere.

The internal mode value remains `continue` for compatibility with the existing state machine.

## Offline reporting

Auto Archaeology adds compact summaries to Melvor's normal **While You Were Away** recap.

- **Discovery** groups completed artefact sizes, site completion, remaining charges, skipped complete sites and sites that need maps.
- **Restock** reports each selected target's net bank change and source-site outcome, plus exhausted maps and source sites needing maps.
- **Use All Maps** reports only how many maps were exhausted across how many dig sites, plus the final/stop state.

The detailed chronological event trail remains available internally through the mod API for diagnostics.

## Notifications

Blocking stop/completion popups are suppressed during offline processing. The offline recap contains the reason instead. During online play, stop/completion information uses a small non-blocking toast.

## Implementation notes

- State transitions run at `Game.tick.after`, matching the proven Auto Cartographer architecture and working during offline simulation.
- Exact pre-action site/map capture prevents vanilla clearing `currentDigSite` from accidentally resetting route progression.
- All three modes use the same safe one-lap circular site traversal.
- The native Archaeology offline recap integration remains in use.
- Restock targets come from live Archaeology drop tables rather than a hard-coded item list.

## Release-candidate defaults

The RC uses fresh settings keys so temporary stress-test defaults from v0.2.x do not carry over unexpectedly:

- Mode defaults to **Discovery**.
- Restock targets default to **none selected**.
