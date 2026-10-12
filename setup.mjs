export async function setup(ctx) {
  const PREFIX = "[Auto Archaeology]";
  const ARTEFACT_TYPES = ["tiny", "small", "medium", "large"];
  const ARTEFACT_TYPE_LABELS = {
    tiny: "Tiny",
    small: "Small",
    medium: "Medium",
    large: "Large",
  };

  const state = {
    pendingReconcile: false,
    changingAction: false,

    // Exact action context captured before the deferred tick boundary. Vanilla
    // is allowed to clear currentDigSite when an action stops, so reconcile()
    // must not depend on currentDigSite still being populated.
    lastActionContext: undefined,

    // Stable route context for the current automation run. Vanilla may clear
    // currentDigSite between an Archaeology action and our deferred tick, so we
    // retain the exact last site we managed. Route searches are circular: they
    // scan every other dig site once, then stop only after a full lap finds no
    // eligible work.
    runAnchorSite: undefined,
    progressSite: undefined,

    // Entering Restock Mode starts a fresh source scan from the earliest
    // eligible dig site. Once underway, subsequent searches wrap around the
    // Archaeology site list rather than stopping at the end.
    restartRestockRoute: false,
  };

  const restockCandidates = collectRestockCandidates();
  const restockOptions = restockCandidates.map(({ item, sources }) => ({
    value: item.id,
    label: item.name,
    hint: sources.join(", "),
  }));
  // Release default: Restock is opt-in and starts with no targets selected.
  // The earlier stress-test builds preselected a small spread of consumables.
  const defaultRestockTargetIDs = [];

  const { GENERAL, RESTOCK } = (await ctx.loadModule("src/settings.mjs"))
    .setupGeneralSettings(
      ctx,
      restockOptions,
      defaultRestockTargetIDs,
      (value, previousValue) => handleModeChange(value, previousValue),
      () => handleRestockTargetsChange()
    );

  const restockCandidateByID = new Map(
    restockCandidates.map(({ item }) => [item.id, item])
  );
  const restockCandidateEntryByID = new Map(
    restockCandidates.map((entry) => [entry.item.id, entry])
  );

  const info = (...args) => console.log(PREFIX, ...args);
  const warn = (...args) => console.warn(PREFIX, ...args);

  const enabled = () => GENERAL.get("enabled") === true;
  const mode = () => GENERAL.get("mode-v100rc1") ?? "discovery";
  const discoveryMode = () => mode() === "discovery";
  const restockMode = () => mode() === "restock";
  const continueMode = () => mode() === "continue";
  const restockTargetIDs = () => new Set(RESTOCK.get("restock-targets-v100rc1") ?? []);

  // Release candidate settings use fresh keys so temporary stress-test defaults
  // from earlier builds do not silently carry over. Discovery is the clean-install
  // default; Restock remains opt-in.
  if (restockMode()) state.restartRestockRoute = true;


  /*
   * Offline reporting
   * -----------------
   * Auto Archaeology can change maps and dig sites during Melvor's offline
   * simulation. Vanilla reporting does not explain those automation decisions,
   * which makes it difficult to verify that progression happened in the
   * intended order. Keep a small chronological audit trail and append it to
   * Archaeology's normal offline recap.
   */
  const offlineReport = {
    active: false,
    actions: 0,
    events: [],
    seen: new Set(),
    deliveryCalls: 0,
    restockStartQuantities: new Map(),

    // Structured reporting state. The chronological event list above remains
    // available through ctx.api() for diagnostics, but the user-facing offline
    // recap is built from these aggregates so long runs do not become a wall
    // of one-line events.
    siteSummaries: new Map(),
    siteOrder: [],
    skippedCompleteSites: new Set(),
    skippedNoMapSites: new Set(),
    stopReason: undefined,
    discoveryNeedsMaps: [],
    restockNeedsMaps: [],
    restockVisitedSiteIDs: new Set(),
  };

  function resetOfflineReport() {
    offlineReport.active = false;
    offlineReport.actions = 0;
    offlineReport.events = [];
    offlineReport.seen = new Set();
    offlineReport.deliveryCalls = 0;
    offlineReport.restockStartQuantities = new Map();
    offlineReport.siteSummaries = new Map();
    offlineReport.siteOrder = [];
    offlineReport.skippedCompleteSites = new Set();
    offlineReport.skippedNoMapSites = new Set();
    offlineReport.stopReason = undefined;
    offlineReport.discoveryNeedsMaps = [];
    offlineReport.restockNeedsMaps = [];
    offlineReport.restockVisitedSiteIDs = new Set();
  }

  function isOfflineProcessing() {
    try {
      return (
        (typeof loadingOfflineProgress !== "undefined" &&
          loadingOfflineProgress === true) ||
        offlineReport.active
      );
    } catch (_) {
      return offlineReport.active;
    }
  }

  function recordOfflineEvent(message, key) {
    if (!isOfflineProcessing() || !enabled()) return;

    if (key) {
      if (offlineReport.seen.has(key)) return;
      offlineReport.seen.add(key);
    }

    offlineReport.events.push(message);
  }

  function formatNameList(names) {
    if (names.length === 0) return "";
    if (names.length === 1) return names[0];
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  }

  function artefactTypeLabel(type) {
    return ARTEFACT_TYPE_LABELS[type] ?? String(type);
  }

  function offlineSiteSummary(site) {
    if (!site) return undefined;

    let summary = offlineReport.siteSummaries.get(site.id);
    if (!summary) {
      summary = {
        site,
        completedTypes: new Set(),
        exhaustedMaps: new Set(),
        mapSwitches: [],
        siteComplete: undefined,
      };
      offlineReport.siteSummaries.set(site.id, summary);
      offlineReport.siteOrder.push(site.id);
    }
    return summary;
  }

  function formatMapNumbers(indices) {
    const numbers = [...indices]
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((a, b) => a - b)
      .map((index) => String(index + 1));
    return formatNameList(numbers);
  }

  function recordOfflineMapExhausted(site, index) {
    if (!site || !Number.isInteger(index) || index < 0) return;
    offlineSiteSummary(site)?.exhaustedMaps.add(index);
    recordOfflineEvent(
      `${site.name}: Dig Site Map ${index + 1} exhausted.`,
      `exhausted:${site.id}:${index}`
    );
  }

  function recordOfflineMapSwitch(site, fromIndex, toIndex) {
    if (
      !site ||
      !Number.isInteger(toIndex) ||
      toIndex < 0 ||
      fromIndex === toIndex
    ) {
      return;
    }

    const charges = site.maps?.[toIndex]?.charges;
    const chargeText = Number.isFinite(charges)
      ? ` (${charges.toLocaleString()} charges)`
      : "";

    offlineSiteSummary(site)?.mapSwitches.push({
      fromIndex,
      toIndex,
      charges: Number.isFinite(charges) ? charges : undefined,
    });

    recordOfflineEvent(
      `${site.name}: switched to Dig Site Map ${toIndex + 1}${chargeText}.`
    );
  }

  function recordOfflineTypeComplete(site, type, toolDisabled) {
    if (!site || !type) return;
    offlineSiteSummary(site)?.completedTypes.add(type);
    const suffix = toolDisabled ? " — tool disabled." : ".";
    recordOfflineEvent(
      `${site.name}: ${artefactTypeLabel(type)} artefacts complete${suffix}`,
      `type-complete:${site.id}:${type}`
    );
  }

  function recordOfflineSiteComplete(site, map, mapIndex) {
    if (!site) return;

    let detail = "";
    if (map && Number.isInteger(mapIndex) && mapIndex >= 0) {
      const charges = Number(map.charges ?? 0);
      detail =
        ` (Dig Site Map ${mapIndex + 1}: ` +
        `${charges.toLocaleString()} ${charges === 1 ? "charge" : "charges"} remaining)`;
    }

    const summary = offlineSiteSummary(site);
    if (summary) {
      summary.siteComplete = {
        mapIndex: Number.isInteger(mapIndex) ? mapIndex : -1,
        charges: map ? Number(map.charges ?? 0) : undefined,
      };
    }

    recordOfflineEvent(
      `${site.name}: all obtainable artefacts discovered${detail}.`,
      `site-complete:${site.id}`
    );
  }

  function recordOfflineSiteMove(fromSite, toSite, reason) {
    if (!fromSite || !toSite || fromSite === toSite) return;
    const reasonText = reason ? ` (${reason})` : "";
    recordOfflineEvent(
      `Moved ${fromSite.name} → ${toSite.name}${reasonText}.`
    );
  }

  function recordOfflineSkippedSites(fromSite, toSite) {
    if (!fromSite || !toSite || fromSite === toSite) return;

    const ordered = allDigSites();
    const fromIndex = ordered.indexOf(fromSite);
    const toIndex = ordered.indexOf(toSite);
    if (fromIndex < 0 || toIndex < 0) return;

    const between = [];
    for (let offset = 1; offset < ordered.length; offset++) {
      const index = (fromIndex + offset) % ordered.length;
      if (index === toIndex) break;
      between.push(ordered[index]);
    }
    if (between.length === 0) return;

    const complete = [];
    const noMaps = [];

    for (const site of between) {
      if (!siteIsAvailable(site)) continue;

      if (discoveryMode() && !siteHasMissingDiscoveries(site)) {
        complete.push(site.name);
      } else if (restockMode()) {
        if (siteHasRestockTargets(site) && !siteHasChargedMap(site))
          noMaps.push(site.name);
      } else if (!siteHasChargedMap(site)) {
        noMaps.push(site.name);
      }
    }

    if (complete.length > 0) {
      complete.forEach((name) => offlineReport.skippedCompleteSites.add(name));
      recordOfflineEvent(
        `Skipped ${formatNameList(complete)}: already discovery-complete.`,
        `skip-complete:${fromSite.id}:${toSite.id}:${complete.join("|")}`
      );
    }

    if (noMaps.length > 0) {
      noMaps.forEach((name) => offlineReport.skippedNoMapSites.add(name));
      recordOfflineEvent(
        `Skipped ${formatNameList(noMaps)}: no charged maps available.`,
        `skip-no-maps:${fromSite.id}:${toSite.id}:${noMaps.join("|")}`
      );
    }
  }

  function recordOfflineStop(reason) {
    offlineReport.stopReason = reason;
    recordOfflineEvent(`Stopped: ${reason}.`, `stop:${reason}`);
  }

  function notifyOnline(title, message) {
    info(title, message);
    if (isOfflineProcessing()) return;

    try {
      if (typeof SwalLocale !== "undefined") {
        SwalLocale.fire({
          toast: true,
          position: "top-end",
          icon: "info",
          title,
          text: message,
          timer: 6500,
          timerProgressBar: true,
          showConfirmButton: false,
        });
      }
    } catch (_) {}
  }

  function itemLooksConsumable(item) {
    if (!item) return false;

    // Archaeology's consumable artefacts use the game's normal item type.
    // Keep a slot-based fallback for compatibility with modded items that may
    // expose consumable equipment without the literal type string.
    if (String(item.type ?? "").toLowerCase() === "consumable") return true;

    const slots = item.validSlots ?? item.validEquipmentSlots;
    if (slots && typeof slots[Symbol.iterator] === "function") {
      for (const slot of slots) {
        const value = String(
          slot?.id ?? slot?.localID ?? slot?.name ?? slot ?? ""
        ).toLowerCase();
        if (value.includes("consumable")) return true;
      }
    }

    return false;
  }

  function collectRestockCandidates() {
    const byID = new Map();

    for (const site of game.archaeology.actions.allObjects) {
      for (const type of ARTEFACT_TYPES) {
        const table = site?.artefacts?.[type];
        for (const drop of table?.drops ?? []) {
          const item = drop?.item;
          if (!itemLooksConsumable(item)) continue;

          let entry = byID.get(item.id);
          if (!entry) {
            entry = { item, sources: [], sourceDetails: [] };
            byID.set(item.id, entry);
          }

          const source = `${site.name} (${ARTEFACT_TYPE_LABELS[type] ?? type})`;
          if (!entry.sources.includes(source)) entry.sources.push(source);
          if (
            !entry.sourceDetails.some(
              (detail) => detail.site === site && detail.type === type
            )
          ) {
            entry.sourceDetails.push({ site, type });
          }
        }
      }
    }

    return [...byID.values()].sort((a, b) =>
      a.item.name.localeCompare(b.item.name)
    );
  }


  function selectedRestockItems() {
    return [...restockTargetIDs()]
      .map((id) => restockCandidateByID.get(id))
      .filter(Boolean);
  }

  function restockTypesForSite(site) {
    const targets = restockTargetIDs();
    if (targets.size === 0) return new Set();

    return new Set(
      ARTEFACT_TYPES.filter((type) =>
        dropItemsForType(site, type).some((item) => targets.has(item.id))
      )
    );
  }

  function siteHasRestockTargets(site) {
    return restockTypesForSite(site).size > 0;
  }

  function allDigSites() {
    return [...game.archaeology.actions.allObjects].sort((a, b) => {
      const levelDiff = (a.level ?? 0) - (b.level ?? 0);
      if (levelDiff !== 0) return levelDiff;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function siteIndex(site) {
    if (!site) return -1;
    return allDigSites().indexOf(site);
  }

  function resetRunFromPlayerSite(site) {
    if (!site) return;
    state.runAnchorSite = site;
    state.progressSite = site;
    info(`Progression anchor set to ${site.name}.`);
  }

  function handleModeChange(value, previousValue) {
    if (value === previousValue) return;

    state.lastActionContext = undefined;

    if (value === "restock") {
      // Restock is target-source driven, not a continuation of a Discovery run.
      // Start one fresh forward pass from the earliest eligible source site.
      state.runAnchorSite = undefined;
      state.progressSite = undefined;
      state.restartRestockRoute = true;
    } else {
      state.restartRestockRoute = false;
      const site = game.archaeology.currentDigSite;
      if (site) resetRunFromPlayerSite(site);
    }

    requestReconcile();
  }

  function handleRestockTargetsChange() {
    if (!restockMode()) return;
    state.lastActionContext = undefined;
    state.runAnchorSite = undefined;
    state.progressSite = undefined;
    state.restartRestockRoute = true;
    requestReconcile();
  }

  function rememberProgressSite(site) {
    if (!site) return;

    if (!state.runAnchorSite) state.runAnchorSite = site;
    state.progressSite = site;
  }

  function resolveManagedSite(...candidates) {
    const ordered = allDigSites();
    for (const site of [...candidates, state.progressSite, state.runAnchorSite]) {
      if (site && ordered.includes(site)) return site;
    }
    return undefined;
  }

  /*
   * Match Auto Cartographer's proven availability rule: a discovered
   * Archaeology site may remain usable even if its associated Cartography POI
   * is currently "hidden", so isHidden is deliberately not used here.
   */
  function siteIsAvailable(site) {
    if (!site || !site.isDiscovered) return false;

    try {
      if (!game.archaeology.isMasteryActionUnlocked(site)) return false;
    } catch (_) {}

    return true;
  }

  function dropItemsForType(site, type) {
    const table = site?.artefacts?.[type];
    if (!table?.drops) return [];

    const items = [];
    const seen = new Set();

    for (const drop of table.drops) {
      const item = drop?.item;
      if (!item || seen.has(item)) continue;
      seen.add(item);
      items.push(item);
    }

    return items;
  }

  function itemWasDiscovered(item) {
    try {
      return game.stats.itemFindCount(item) > 0;
    } catch (_) {
      return false;
    }
  }

  function missingItemsForType(site, type) {
    return dropItemsForType(site, type).filter(
      (item) => !itemWasDiscovered(item)
    );
  }

  function missingTypesForSite(site) {
    return new Set(
      ARTEFACT_TYPES.filter(
        (type) => missingItemsForType(site, type).length > 0
      )
    );
  }

  function siteHasMissingDiscoveries(site) {
    return missingTypesForSite(site).size > 0;
  }

  function chargedMapIndices(site) {
    const result = [];
    site?.maps?.forEach((map, index) => {
      if ((map?.charges ?? 0) > 0) result.push(index);
    });
    return result;
  }

  function siteHasChargedMap(site) {
    return chargedMapIndices(site).length > 0;
  }

  function nextChargedMapIndex(site) {
    const charged = chargedMapIndices(site);
    if (charged.length === 0) return -1;

    const selected = Number(site.selectedMapIndex);
    if (Number.isInteger(selected) && charged.includes(selected))
      return selected;

    if (Number.isInteger(selected) && selected >= 0) {
      const later = charged.find((index) => index > selected);
      if (later !== undefined) return later;
    }

    return charged[0];
  }

  function siteHasWork(site) {
    if (!siteIsAvailable(site) || !siteHasChargedMap(site)) return false;
    if (discoveryMode()) return siteHasMissingDiscoveries(site);
    if (restockMode()) return siteHasRestockTargets(site);
    return true;
  }

  function findFirstWorkSite() {
    return allDigSites().find((site) => siteHasWork(site));
  }

  function findNextSite(preferAfter) {
    const ordered = allDigSites();
    if (ordered.length === 0) return undefined;

    // currentDigSite is optional and may already have been cleared by vanilla
    // before our deferred reconciliation runs. Anchor the search on the exact
    // captured/remembered site instead of falling back to index -1 (the old
    // source of accidental jumps to Old Village).
    const anchor = resolveManagedSite(preferAfter);
    const start = anchor ? ordered.indexOf(anchor) : -1;

    if (anchor && start < 0) {
      warn(`Could not locate ${anchor.name} in the Archaeology site list.`);
      return undefined;
    }

    // Scan every *other* site exactly once. continueCurrentSite() has already
    // handled any remaining work at the anchor itself, so reaching it again
    // would mean one complete lap with no alternative eligible target.
    const checks = anchor ? ordered.length - 1 : ordered.length;
    for (let offset = 1; offset <= checks; offset++) {
      const index = (start + offset + ordered.length) % ordered.length;
      const site = ordered[index];
      if (siteHasWork(site)) return site;
    }

    return undefined;
  }

  function selectedToolForType(site, type) {
    return site.selectedTools?.find((tool) => tool.artefactType === type);
  }

  function toolForType(type) {
    try {
      return game.archaeology.artefactTypeTools.get(type);
    } catch (_) {
      return undefined;
    }
  }

  function configureAutomationTools(site) {
    if (continueMode()) return true;

    const needed = discoveryMode()
      ? missingTypesForSite(site)
      : restockTypesForSite(site);

    for (const type of ARTEFACT_TYPES) {
      const selected = selectedToolForType(site, type);

      if (!needed.has(type)) {
        if (selected) {
          game.archaeology.setToolAsInactive(site, selected);
          info(
            discoveryMode()
              ? `Disabled ${type} tool at ${site.name}; that size is complete.`
              : `Disabled ${type} tool at ${site.name}; no selected Restock target drops there.`
          );
        }
        continue;
      }

      if (!selected) {
        const tool = toolForType(type);
        if (!tool) {
          warn(`No active Archaeology tool is available for ${type} artefacts.`);
          return false;
        }

        game.archaeology.setToolAsActive(site, tool);
        info(`Enabled ${tool.name ?? type} at ${site.name}.`);
      }
    }

    return true;
  }

  function stopArchaeologyInternally() {
    const archaeology = game.archaeology;
    if (!archaeology.isActive) return;

    state.changingAction = true;
    try {
      archaeology.stop();
    } finally {
      state.changingAction = false;
    }
  }

  function startSite(site, index) {
    const archaeology = game.archaeology;
    const map = site.maps[index];

    if (!map || map.charges <= 0) return false;

    stopArchaeologyInternally();

    archaeology.setMapAsActive(site, index);

    if (!configureAutomationTools(site)) {
      warn(`Could not configure ${mode()} tools for ${site.name}.`);
      return false;
    }

    state.changingAction = true;
    try {
      archaeology.startDigging(site);
    } finally {
      state.changingAction = false;
    }

    const started =
      archaeology.isActive &&
      archaeology.currentDigSite === site &&
      site.selectedMap === map;

    if (started) {
      rememberProgressSite(site);
      if (isOfflineProcessing() && restockMode())
        offlineReport.restockVisitedSiteIDs.add(site.id);
      info(
        `Excavating ${site.name} map ${index + 1} ` +
        `(${map.charges.toLocaleString()} charges).`
      );
    }

    return started;
  }

  function continueCurrentSite(site) {
    if (!siteHasWork(site)) return false;

    const index = nextChargedMapIndex(site);
    if (index < 0) return false;

    const selectedMap = site.selectedMap;
    const alreadyRunning =
      game.archaeology.isActive &&
      game.archaeology.currentDigSite === site &&
      selectedMap === site.maps[index] &&
      selectedMap?.charges > 0;

    if (alreadyRunning) {
      configureAutomationTools(site);
      return true;
    }

    return startSite(site, index);
  }

  function reconcile() {
    if (!enabled()) return;

    const archaeology = game.archaeology;
    const actionContext = state.lastActionContext;

    if (restockMode() && state.restartRestockRoute) {
      state.restartRestockRoute = false;

      if (restockTargetIDs().size === 0) {
        stopArchaeologyInternally();
        recordOfflineStop("Restock Mode has no selected consumable targets");
        notifyOnline(
          "Auto Archaeology paused",
          "Restock Mode has no consumables selected in the mod settings."
        );
        state.lastActionContext = undefined;
        return;
      }

      const first = findFirstWorkSite();
      if (first) {
        const index = nextChargedMapIndex(first);
        if (index >= 0 && startSite(first, index)) {
          state.lastActionContext = undefined;
          return;
        }
      }

      stopArchaeologyInternally();
      recordOfflineStop(
        "no charged maps remain at dig sites containing the selected Restock targets"
      );
      notifyOnline(
        "Restock Mode paused",
        "No charged maps remain at dig sites containing the selected Restock targets."
      );
      state.lastActionContext = undefined;
      return;
    }

    // Prefer the exact pre-action context when it exists, then live vanilla
    // state, then our remembered site. This preserves the v0.1.2 protection
    // against currentDigSite being cleared without imposing forward-only order.
    const current = resolveManagedSite(
      actionContext?.site,
      archaeology.currentDigSite,
      state.progressSite
    );
    const previousMapIndex = Number.isInteger(actionContext?.mapIndex)
      ? actionContext.mapIndex
      : current
        ? Number(current.selectedMapIndex)
        : -1;
    const previousMap = actionContext?.map ?? current?.selectedMap;
    const previousMapExhausted =
      !!current && !!previousMap && (previousMap.charges ?? 0) <= 0;

    const missingAfter =
      current && discoveryMode() ? missingTypesForSite(current) : undefined;
    const newlyCompletedTypes =
      current &&
      discoveryMode() &&
      actionContext?.site === current &&
      Array.isArray(actionContext?.missingTypesBefore)
        ? actionContext.missingTypesBefore.filter(
            (type) => !missingAfter.has(type)
          )
        : [];
    const currentSiteComplete =
      !!current && discoveryMode() && missingAfter?.size === 0;

    // Continue at the current site while it still has useful work.
    if (current && continueCurrentSite(current)) {
      for (const type of newlyCompletedTypes) {
        recordOfflineTypeComplete(
          current,
          type,
          !selectedToolForType(current, type)
        );
      }

      if (previousMapExhausted) {
        recordOfflineMapExhausted(current, previousMapIndex);
        recordOfflineMapSwitch(
          current,
          previousMapIndex,
          Number(current.selectedMapIndex)
        );
      }
      state.lastActionContext = undefined;
      return;
    }

    for (const type of newlyCompletedTypes)
      recordOfflineTypeComplete(current, type, false);

    if (previousMapExhausted)
      recordOfflineMapExhausted(current, previousMapIndex);

    if (currentSiteComplete)
      recordOfflineSiteComplete(current, previousMap, previousMapIndex);

    const next = findNextSite(current);
    if (next) {
      const index = nextChargedMapIndex(next);
      if (index >= 0 && startSite(next, index)) {
        if (current && current !== next) {
          info(`Moved from ${current.name} to ${next.name}.`);
          recordOfflineSkippedSites(current, next);

          const reason = discoveryMode()
            ? currentSiteComplete
              ? `${current.name} complete`
              : !siteHasChargedMap(current)
                ? `no charged maps remain at ${current.name}`
                : "next eligible site"
            : restockMode()
              ? !siteHasChargedMap(current)
                ? `no charged maps remain at ${current.name}`
                : "next selected-target source"
              : !siteHasChargedMap(current)
                ? `no charged maps remain at ${current.name}`
                : "next eligible site";

          recordOfflineSiteMove(current, next, reason);
        }
        state.lastActionContext = undefined;
        return;
      }
    }

    // A full circular pass found no other useful site. Discovery/Restock avoid
    // irrelevant sites; Use All Maps treats every charged map as useful. In all
    // modes, stop only after every other site has been considered once.
    stopArchaeologyInternally();

    if (discoveryMode()) {
      const incompleteButUnmapped = allDigSites().filter(
        (site) =>
          siteIsAvailable(site) &&
          siteHasMissingDiscoveries(site) &&
          !siteHasChargedMap(site)
      );

      if (incompleteButUnmapped.length > 0) {
        offlineReport.discoveryNeedsMaps = [...incompleteButUnmapped];
        const reason =
          "no charged maps remain for any incomplete Archaeology sites";
        recordOfflineStop(reason);
        recordOfflineEvent(
          `${incompleteButUnmapped.length} incomplete ` +
          `${incompleteButUnmapped.length === 1 ? "site needs" : "sites need"} more maps.`,
          `unmapped-incomplete:${incompleteButUnmapped.map((site) => site.id).join("|")}`
        );
        notifyOnline(
          "Auto Archaeology paused",
          `No charged maps remain; ${incompleteButUnmapped.length} incomplete ` +
          `${incompleteButUnmapped.length === 1 ? "site needs" : "sites need"} more maps.`
        );
      } else {
        const reason =
          "every currently available Archaeology item has been discovered";
        recordOfflineStop(reason);
        notifyOnline(
          "Discovery Mode complete",
          "Every currently available Archaeology item has been discovered."
        );
      }
    } else if (restockMode()) {
      const targets = selectedRestockItems();
      const targetNames = targets.map((item) => item.name);
      const sourceSites = allDigSites().filter(
        (site) => siteIsAvailable(site) && siteHasRestockTargets(site)
      );
      const unmappedSources = sourceSites.filter((site) => !siteHasChargedMap(site));

      if (targetNames.length === 0) {
        recordOfflineStop("Restock Mode has no selected consumable targets");
        notifyOnline(
          "Auto Archaeology paused",
          "Restock Mode has no consumables selected in the mod settings."
        );
      } else if (sourceSites.length === 0) {
        recordOfflineStop(
          "the selected Restock targets have no currently available dig-site sources"
        );
        notifyOnline(
          "Restock Mode paused",
          "The selected Restock targets have no currently available dig-site sources."
        );
      } else {
        offlineReport.restockNeedsMaps = [...unmappedSources];
        recordOfflineStop(
          "no charged maps remain at dig sites containing the selected Restock targets"
        );
        if (unmappedSources.length > 0) {
          recordOfflineEvent(
            `${unmappedSources.length} selected-target ` +
            `${unmappedSources.length === 1 ? "site needs" : "sites need"} more maps.`,
            `restock-unmapped:${unmappedSources.map((site) => site.id).join("|")}`
          );
        }
        notifyOnline(
          "Restock Mode paused",
          `No charged maps remain for ${formatNameList(targetNames)}.`
        );
      }
    } else {
      recordOfflineStop(
        "no charged maps remain at any currently available Archaeology dig site"
      );
      notifyOnline(
        "Auto Archaeology finished",
        "No charged maps remain at any currently available Archaeology dig site."
      );
    }

    state.lastActionContext = undefined;
  }

  function requestReconcile() {
    state.pendingReconcile = true;
  }

  /*
   * Archaeology events fire inside the action stack. As with Auto Cartographer,
   * defer action/site/tool switches until Game.tick has completed so the same
   * state machine works during Melvor's offline tick simulation.
   */
  ctx.patch(Game, "tick").after(function () {
    if (!state.pendingReconcile) return;
    state.pendingReconcile = false;
    reconcile();
  });

  function captureActionContext() {
    const site = game.archaeology.currentDigSite ?? state.progressSite;
    const map = site?.selectedMap;
    const mapIndex = map ? site.maps.indexOf(map) : Number(site?.selectedMapIndex);

    if (!site) return;

    rememberProgressSite(site);
    state.lastActionContext = {
      site,
      map,
      mapIndex: Number.isInteger(mapIndex) ? mapIndex : -1,
      // Reporting-only snapshot. This lets the offline recap say exactly when a
      // Tiny/Small/Medium/Large category became complete without influencing
      // any of the discovery or progression decisions themselves.
      missingTypesBefore: discoveryMode()
        ? [...missingTypesForSite(site)]
        : undefined,
    };
  }

  // Capture before the Archaeology action mutates map charges or vanilla stop
  // logic has a chance to clear currentDigSite/selectedMap. The stored map is an
  // object reference, so its post-action charge count is visible at tick.after.
  ctx.patch(Archaeology, "preAction").before(function () {
    if (enabled()) captureActionContext();
  });

  game.archaeology.on("action", () => {
    if (!enabled()) return;

    // Fallback for unusual call paths where preAction was not observed. Do not
    // overwrite a stronger preAction snapshot with already-cleared vanilla state.
    if (!state.lastActionContext) captureActionContext();

    if (isOfflineProcessing()) offlineReport.actions += 1;
    requestReconcile();
  });

  // Apply Discovery Mode/tool selection promptly when excavation is started by
  // the player, without waiting for the first completed excavation action.
  ctx.patch(Archaeology, "startDigging").after(function () {
    if (!enabled() || state.changingAction) return;

    const site = game.archaeology.currentDigSite;
    if (site) {
      resetRunFromPlayerSite(site);
      state.restartRestockRoute = false;
    }
    requestReconcile();
  });

  game.on("offlineLoopEntered", () => {
    resetOfflineReport();
    offlineReport.active = enabled();

    if (offlineReport.active && restockMode()) {
      for (const item of selectedRestockItems()) {
        try {
          offlineReport.restockStartQuantities.set(item.id, game.bank.getQty(item));
        } catch (_) {}
      }
    }
  });

  function buildOfflineFinalStateLine() {
    const site = game.archaeology.currentDigSite ?? state.progressSite;
    if (!site) return undefined;

    const liveAtSite =
      game.archaeology.isActive && game.archaeology.currentDigSite === site;

    if (!liveAtSite) return `Final state: Archaeology stopped at ${site.name}.`;

    const map = site.selectedMap;
    const mapIndex = map ? site.maps.indexOf(map) : Number(site.selectedMapIndex);
    const mapText =
      map && Number.isInteger(mapIndex) && mapIndex >= 0
        ? `Dig Site Map ${mapIndex + 1}, ${(map.charges ?? 0).toLocaleString()} charges`
        : "no active map";

    if (continueMode())
      return `Final state: ${site.name} — ${mapText}; continuing excavation.`;

    if (restockMode()) {
      const types = [...restockTypesForSite(site)].map(artefactTypeLabel);
      const targets = selectedRestockItems().map((item) => item.name);
      return (
        `Final state: ${site.name} — ${mapText}; Restock targeting ` +
        `${formatNameList(targets)}${types.length ? ` via ${formatNameList(types)} artefacts` : ""}.`
      );
    }

    const needed = [...missingTypesForSite(site)].map(artefactTypeLabel);
    if (needed.length === 0)
      return `Final state: ${site.name} — ${mapText}; site discovery-complete.`;

    return (
      `Final state: ${site.name} — ${mapText}; pursuing ` +
      `${formatNameList(needed)} artefacts.`
    );
  }

  function buildDiscoverySummaryLines() {
    const lines = [];

    for (const siteID of offlineReport.siteOrder) {
      const summary = offlineReport.siteSummaries.get(siteID);
      if (!summary) continue;

      const parts = [];
      const completed = ARTEFACT_TYPES.filter((type) =>
        summary.completedTypes.has(type)
      ).map(artefactTypeLabel);
      if (completed.length > 0)
        parts.push(`completed ${formatNameList(completed)}`);

      if (summary.siteComplete) {
        const { mapIndex, charges } = summary.siteComplete;
        if (Number.isInteger(mapIndex) && mapIndex >= 0 && Number.isFinite(charges)) {
          parts.push(
            `site complete with ${charges.toLocaleString()} ` +
            `${charges === 1 ? "charge" : "charges"} left on Map ${mapIndex + 1}`
          );
        } else {
          parts.push("site complete");
        }
      }

      if (summary.exhaustedMaps.size > 0) {
        const maps = formatMapNumbers(summary.exhaustedMaps);
        parts.push(
          `${summary.exhaustedMaps.size === 1 ? "Map" : "Maps"} ${maps} exhausted`
        );
      }

      if (parts.length > 0)
        lines.push(`${summary.site.name} — ${parts.join("; ")}.`);
    }

    if (offlineReport.skippedCompleteSites.size > 0) {
      lines.push(
        `Skipped already-complete sites: ` +
        `${formatNameList([...offlineReport.skippedCompleteSites])}.`
      );
    }

    if (offlineReport.skippedNoMapSites.size > 0) {
      lines.push(
        `Skipped sites without charged maps: ` +
        `${formatNameList([...offlineReport.skippedNoMapSites])}.`
      );
    }

    if (offlineReport.discoveryNeedsMaps.length > 0) {
      lines.push(
        `Need maps: ${formatNameList(offlineReport.discoveryNeedsMaps.map((site) => site.name))}.`
      );
    }

    return lines;
  }

  function buildRestockSummaryLines() {
    const lines = [];

    for (const item of selectedRestockItems()) {
      const before = offlineReport.restockStartQuantities.get(item.id);
      if (!Number.isFinite(before)) continue;

      let after;
      try {
        after = game.bank.getQty(item);
      } catch (_) {
        continue;
      }

      const delta = after - before;
      const signedDelta = `${delta > 0 ? "+" : ""}${delta.toLocaleString()}`;
      const candidate = restockCandidateEntryByID.get(item.id);
      const sourceSites = [...new Set(
        (candidate?.sourceDetails ?? [])
          .map(({ site }) => site)
          .filter((site) => siteIsAvailable(site))
      )];
      const visited = sourceSites.filter((site) =>
        offlineReport.restockVisitedSiteIDs.has(site.id)
      );
      const charged = sourceSites.filter((site) => siteHasChargedMap(site));

      let status = "";
      if (visited.length > 0) {
        status = `farmed at ${formatNameList(visited.map((site) => site.name))}`;
        const remainingElsewhere = charged.filter((site) => !visited.includes(site));
        if (remainingElsewhere.length > 0) {
          status += `; charged maps remain at ${formatNameList(remainingElsewhere.map((site) => site.name))}`;
        }
      } else if (charged.length > 0) {
        status = `not reached; charged maps remain at ${formatNameList(charged.map((site) => site.name))}`;
      } else if (sourceSites.length > 0) {
        status = `not farmed; no charged maps at ${formatNameList(sourceSites.map((site) => site.name))}`;
      } else {
        status = "no currently available source site";
      }

      lines.push(
        `${item.name}: ${signedDelta} net (${after.toLocaleString()} bank) — ${status}.`
      );
    }

    const exhausted = [];
    for (const siteID of offlineReport.siteOrder) {
      const summary = offlineReport.siteSummaries.get(siteID);
      if (!summary || summary.exhaustedMaps.size === 0) continue;
      const maps = formatMapNumbers(summary.exhaustedMaps);
      exhausted.push(
        `${summary.site.name} ${summary.exhaustedMaps.size === 1 ? "Map" : "Maps"} ${maps}`
      );
    }
    if (exhausted.length > 0)
      lines.push(`Maps exhausted: ${exhausted.join("; ")}.`);

    if (offlineReport.restockNeedsMaps.length > 0) {
      lines.push(
        `Need maps: ${formatNameList(offlineReport.restockNeedsMaps.map((site) => site.name))}.`
      );
    }

    return lines;
  }

  function buildContinueSummaryLines() {
    let exhaustedMaps = 0;
    let exhaustedSites = 0;

    for (const siteID of offlineReport.siteOrder) {
      const summary = offlineReport.siteSummaries.get(siteID);
      if (!summary || summary.exhaustedMaps.size === 0) continue;
      exhaustedSites += 1;
      exhaustedMaps += summary.exhaustedMaps.size;
    }

    if (exhaustedMaps === 0) return [];

    return [
      `Use All Maps: exhausted ${exhaustedMaps.toLocaleString()} ` +
      `${exhaustedMaps === 1 ? "map" : "maps"} across ` +
      `${exhaustedSites.toLocaleString()} ` +
      `${exhaustedSites === 1 ? "dig site" : "dig sites"}.`,
    ];
  }

  function buildOfflineReportLines() {
    const lines = [];

    if (offlineReport.actions > 0) {
      lines.push(
        `Processed ${offlineReport.actions.toLocaleString()} excavation ` +
        `${offlineReport.actions === 1 ? "action" : "actions"} while offline.`
      );
    }

    if (restockMode()) lines.push(...buildRestockSummaryLines());
    else if (discoveryMode()) lines.push(...buildDiscoverySummaryLines());
    else lines.push(...buildContinueSummaryLines());

    if (offlineReport.stopReason) {
      lines.push(`Stopped: ${offlineReport.stopReason}.`);
    } else if (offlineReport.actions > 0 || offlineReport.events.length > 0) {
      // A final-state line is useful when the offline window ended mid-run, but
      // redundant after a clean stop because the stop/needs-map lines already
      // explain the terminal condition.
      const finalState = buildOfflineFinalStateLine();
      if (finalState) lines.push(finalState);
    }

    return lines;
  }

  /*
   * Native offline recap integration
   * --------------------------------
   * OfflineProgressElement.setMessages() asks the offline action itself for
   * getOfflineMessages(). Cartography defines that method explicitly, while
   * Archaeology does not expose one in the current official typings. Patching
   * a missing class method therefore did nothing in v0.1.2.
   *
   * JavaScript does not require the method to be declared by the class. Add it
   * directly to the live Archaeology action instance, preserving any runtime
   * implementation that may already exist. This lets Melvor's own recap UI
   * consume our strings in exactly the same place as native offline messages,
   * and should also keep Better Offline Recap compatibility.
   */
  const previousGetOfflineMessages =
    typeof game.archaeology.getOfflineMessages === "function"
      ? game.archaeology.getOfflineMessages.bind(game.archaeology)
      : undefined;

  function archaeologyOfflineMessages() {
    let vanillaMessages = [];

    if (previousGetOfflineMessages) {
      try {
        const existing = previousGetOfflineMessages();
        if (Array.isArray(existing)) vanillaMessages = existing;
      } catch (error) {
        warn("Could not read Archaeology's existing offline messages.", error);
      }
    }

    const supplemental = buildOfflineReportLines();
    if (supplemental.length === 0) return vanillaMessages;

    offlineReport.deliveryCalls += 1;
    info("Supplying offline recap messages:", ...supplemental);
    return [...vanillaMessages, ...supplemental];
  }

  let nativeRecapHookInstalled = false;
  try {
    game.archaeology.getOfflineMessages = archaeologyOfflineMessages;
    nativeRecapHookInstalled =
      game.archaeology.getOfflineMessages === archaeologyOfflineMessages;
  } catch (error) {
    warn("Could not install Archaeology offline recap hook.", error);
  }

  game.on("offlineLoopExited", () => {
    offlineReport.active = false;
  });

  info(
    nativeRecapHookInstalled
      ? "Native Archaeology offline recap hook installed."
      : "Native Archaeology offline recap hook was not installed."
  );

  /*
   * v0.1.3 proved that the audit trail itself is correct by displaying it in a
   * second SweetAlert. v0.2.3 keeps the native recap delivery and the detailed
   * audit trail internally, but aggregates the user-facing messages by site/target.
   */

  ctx.api({
    reconcile() {
      requestReconcile();
    },

    status() {
      const site = game.archaeology.currentDigSite;
      return {
        enabled: enabled(),
        mode: mode(),
        discoveryMode: discoveryMode(),
        restockMode: restockMode(),
        active: game.archaeology.isActive,
        currentSite: site?.name,
        selectedMap: site ? site.selectedMapIndex + 1 : undefined,
        selectedMapCharges: site?.selectedMap?.charges,
        runAnchorSite: state.runAnchorSite?.name,
        progressSite: state.progressSite?.name,
        capturedActionSite: state.lastActionContext?.site?.name,
        capturedActionMap: Number.isInteger(state.lastActionContext?.mapIndex)
          ? state.lastActionContext.mapIndex + 1
          : undefined,
        offlineReportActions: offlineReport.actions,
        offlineReportEvents: [...offlineReport.events],
        offlineReportDeliveryCalls: offlineReport.deliveryCalls,
        nativeRecapHookInstalled,
        restockCandidates: restockCandidates.map(({ item, sources }) => ({
          id: item.id,
          name: item.name,
          sources: [...sources],
        })),
        restockTargets: selectedRestockItems().map((item) => item.name),
        restockTypesAtCurrentSite: site
          ? [...restockTypesForSite(site)].map(artefactTypeLabel)
          : undefined,
        missingBySize: site
          ? Object.fromEntries(
              ARTEFACT_TYPES.map((type) => [
                type,
                missingItemsForType(site, type).map((item) => item.name),
              ])
            )
          : undefined,
      };
    },

    missing(siteID) {
      const site = game.archaeology.actions.allObjects.find(
        (candidate) => candidate.id === siteID
      );
      if (!site) return undefined;

      return Object.fromEntries(
        ARTEFACT_TYPES.map((type) => [
          type,
          missingItemsForType(site, type).map((item) => item.name),
        ])
      );
    },
  });

  info(
    `v1.0.0-rc.1 loaded. Mode: ${mode()}. ` +
    `Detected ${restockCandidates.length} Archaeology consumable Restock targets.`
  );
}
