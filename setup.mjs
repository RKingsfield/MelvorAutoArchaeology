/*
Auto Cartographer v1.0.0
Melvor Idle / Atlas of Discovery

v0.2 turns the proven v0.1.6 automation into a configurable mod:
- Native Melvor mod settings.
- Configurable paper refill batch.
- Configurable paper-recipe priority with automatic fallback.
- Safe exhaustion handling: never lets vanilla consume missing ingredients.
- Persists an interrupted map job so a reload during automatic paper-making can resume it.
*/

export async function setup(ctx) {
  const TAG = "[Auto Cartographer]";
  const settingsModule = await ctx.loadModule("src/settings.mjs");
  const { LOG_SETTINGS } = settingsModule;
  const { GENERAL, PAPER } =
    settingsModule.setupGeneralSettings(ctx, openPaperLogPriorityDialog);

  const state = {
    busy: false,
    paperMode: false,
    resumeSite: undefined,
    resumeIndex: -1,
    paperRecipe: undefined,
    paperStartQty: 0,
    paperGoalQty: 0,

    // State changes requested from inside Cartography action callbacks are
    // executed only after the enclosing Game.tick() has completely finished.
    // This is the same safe tick-boundary pattern used by Action Workflows.
    pendingTransition: undefined,

    // Exact map-upgrade target, captured when Cartography actually starts
    // upgrading. Do not infer this later from UI selection state.
    activeUpgradeSite: undefined,
    activeUpgradeIndex: -1,
    activeUpgradeMap: undefined,

    // Runtime object reference to the exact interrupted map. This survives
    // switching Cartography modes and is more reliable than UI selection state.
    resumeMap: undefined,
  };

  const setting = (section, name, fallback) => {
    try {
      const value = section.get(name);
      return value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  };

  const enabled = () => !!setting(GENERAL, "enabled", true);
  const createMissingMaps = () => !!setting(GENERAL, "create-missing-maps", true);
  const autoMakePaper = () => !!setting(PAPER, "auto-make-paper", true);
  const refillAmount = () =>
    Math.max(
      1,
      Math.floor(Number(setting(PAPER, "paper-refill-amount", 100)) || 100)
    );

  function currentPaperGoal() {
    return state.paperStartQty + refillAmount();
  }

  const info = (...args) => console.info(TAG, ...args);
  const warn = (...args) => console.warn(TAG, ...args);

  function notify(title, html) {
    info(title, html.replace(/<[^>]*>/g, " "));
    try {
      if (typeof SwalLocale !== "undefined") SwalLocale.fire({ title, html });
    } catch (_) {}
  }

  /*
   * Offline reporting
   * -----------------
   * Vanilla Cartography snapshots only the maps known to the dig site being
   * upgraded when offline processing begins. Auto Cartographer can finish that
   * site and move to a different site/map during the same offline loop, so
   * vanilla has no "before" state for those later maps and omits them.
   *
   * This is reporting-only. The proven v0.3.12 automation state machine below
   * is deliberately left untouched.
   */
  const offlineReport = {
    active: false,
    snapshotPrepared: false,
    vanillaTrackedMaps: new Set(),
    maps: new Map(),

    // Meaningful Auto Cartographer decisions/actions that vanilla does not
    // report itself.
    siteMoves: [],
    mapPurchases: [],
    paperRefills: new Map(),
    paperRecipeSwitches: new Map(),
    finishedAllWork: false,
  };

  function resetOfflineReport(vanillaTrackedMaps = []) {
    offlineReport.active = false;
    offlineReport.snapshotPrepared = true;
    offlineReport.vanillaTrackedMaps = new Set(vanillaTrackedMaps);
    offlineReport.maps = new Map();
    offlineReport.siteMoves = [];
    offlineReport.mapPurchases = [];
    offlineReport.paperRefills = new Map();
    offlineReport.paperRecipeSwitches = new Map();
    offlineReport.finishedAllWork = false;
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

  function prepareOfflineReportFromVanillaSnapshot(cartography) {
    const tracked =
      cartography?.offlineSnapshot?.upgradeMapDigSite instanceof Map
        ? [...cartography.offlineSnapshot.upgradeMapDigSite.keys()]
        : [];
    resetOfflineReport(tracked);
  }

  function getOfflineMapReportEntry(map, beforeTierName) {
    if (!map?.digSite) return undefined;

    let entry = offlineReport.maps.get(map);
    if (!entry) {
      entry = {
        map,
        site: map.digSite,
        actions: 0,
        startTierName: beforeTierName ?? map.tier?.name,
      };
      offlineReport.maps.set(map, entry);
    }

    return entry;
  }

  function recordOfflineMapUpgrade(map, actions, beforeTierName) {
    if (
      !isOfflineProcessing() ||
      !enabled() ||
      !map ||
      !Number.isFinite(actions) ||
      actions <= 0
    ) {
      return;
    }

    const entry = getOfflineMapReportEntry(map, beforeTierName);
    if (!entry) return;

    if (entry.actions === 0 && beforeTierName) {
      entry.startTierName = beforeTierName;
    }

    entry.actions += actions;
  }

  function recordOfflineSiteMove(fromSite, toSite) {
    if (
      !isOfflineProcessing() ||
      !enabled() ||
      !fromSite ||
      !toSite ||
      fromSite === toSite
    ) {
      return;
    }

    offlineReport.siteMoves.push({
      fromName: fromSite.name,
      toName: toSite.name,
    });
  }

  function recordOfflineMapPurchase(site, mapNumber) {
    if (!isOfflineProcessing() || !enabled() || !site) return;

    offlineReport.mapPurchases.push({
      siteName: site.name,
      mapNumber,
    });
  }

  function paperRefillKey(site, index) {
    return `${site?.id ?? site?.name ?? "unknown"}:${index}`;
  }

  function recordOfflinePaperRefill(site, index) {
    if (!isOfflineProcessing() || !enabled() || !site) return;

    const key = paperRefillKey(site, index);
    let entry = offlineReport.paperRefills.get(key);
    if (!entry) {
      entry = {
        siteName: site.name,
        mapNumber: index >= 0 ? index + 1 : undefined,
        forMapPurchase: index < 0,
        count: 0,
      };
      offlineReport.paperRefills.set(key, entry);
    }

    entry.count++;
  }

  function paperRecipeLogLabel(recipe) {
    if (!recipe) return undefined;
    const key = recipeLogKey(recipe);
    if (key) return paperLogLabel(key);

    // Recipe display names are usually just "Paper", which is not useful for
    // reporting. Prefer the stable recipe ID if the log type cannot be resolved.
    return recipe.id ?? recipe.localID ?? recipe.name;
  }

  function recordOfflinePaperRecipeSwitch(previous, next) {
    /*
     * The first recipe selected for a refill is not a "switch". state.paperRecipe
     * is intentionally cleared when returning to map upgrading, so treating a
     * missing previous recipe as a switch produced one useless
     * "You used Paper to make Paper" line per refill.
     *
     * Only report a real fallback from one log source to another.
     */
    if (
      !isOfflineProcessing() ||
      !enabled() ||
      !previous ||
      !next ||
      previous.id === next.id
    ) {
      return;
    }

    const fromName = paperRecipeLogLabel(previous);
    const toName = paperRecipeLogLabel(next);
    if (!fromName || !toName || fromName === toName) return;

    const key = `${fromName} -> ${toName}`;
    const existing = offlineReport.paperRecipeSwitches.get(key);
    if (existing) {
      existing.count++;
    } else {
      offlineReport.paperRecipeSwitches.set(key, {
        fromName,
        toName,
        count: 1,
      });
    }
  }

  function buildAutoActionOfflineMessages() {
    const messages = [];

    for (const move of offlineReport.siteMoves) {
      messages.push(
        `You moved from ${move.fromName} to ${move.toName}`
      );
    }

    for (const purchase of offlineReport.mapPurchases) {
      messages.push(
        `You created ${purchase.siteName} Dig Site Map ${purchase.mapNumber}`
      );
    }

    for (const refill of offlineReport.paperRefills.values()) {
      const times =
        refill.count === 1 ? "once" : `${refill.count.toLocaleString()} times`;

      if (refill.forMapPurchase) {
        messages.push(
          `You switched to Paper Making ${times} to create a ${refill.siteName} Dig Site Map`
        );
      } else {
        messages.push(
          `You switched to Paper Making ${times} to continue ` +
          `${refill.siteName} Dig Site Map ${refill.mapNumber}`
        );
      }
    }

    for (const recipe of offlineReport.paperRecipeSwitches.values()) {
      const suffix =
        recipe.count === 1
          ? ""
          : ` ${recipe.count.toLocaleString()} times`;

      messages.push(
        `You switched Paper Making from ${recipe.fromName} to ` +
        `${recipe.toName}${suffix}`
      );
    }

    if (offlineReport.finishedAllWork) {
      messages.push(
        "Auto Cartographer finished every currently available dig-site map slot"
      );
    }

    return messages;
  }

  function buildSupplementalOfflineMessages() {
    const messages = [];

    for (const entry of offlineReport.maps.values()) {
      // Avoid duplicates for maps vanilla snapshotted at logout.
      if (offlineReport.vanillaTrackedMaps.has(entry.map)) continue;
      if (entry.actions <= 0) continue;

      messages.push(
        `You upgraded your ${entry.site.name} Dig Site Map ` +
        `${entry.actions.toLocaleString()} ` +
        `${entry.actions === 1 ? "time" : "times"}`
      );

      const endTierName = entry.map?.tier?.name;
      if (
        entry.startTierName &&
        endTierName &&
        entry.startTierName !== endTierName
      ) {
        messages.push(
          `Your ${entry.site.name} map improved from ` +
          `${entry.startTierName} → ${endTierName}`
        );
      }
    }

    return [...buildAutoActionOfflineMessages(), ...messages];
  }

  ctx.patch(Cartography, "createOfflineSnapshot").after(function () {
    prepareOfflineReportFromVanillaSnapshot(this);
  });

  /*
   * Creator Toolkit local mods use dev mod ID -1. Current game-source testing
   * by other mod authors has shown characterStorage entries for dev mods can
   * be dropped when a save is decoded. Keep a browser-local fallback while
   * developing, keyed by Melvor's current character slot so separate saves do
   * not share recovery/config state.
   *
   * Published mods still use ctx.characterStorage as the primary store.
   */
  function localCharacterKey(name) {
    let character = "unknown";
    try {
      if (typeof currentCharacter !== "undefined")
        character = String(currentCharacter);
    } catch (_) {}

    return `RussellAutoCartographer:${character}:${name}`;
  }

  function readLocalJSON(name) {
    try {
      const raw = window.localStorage.getItem(localCharacterKey(name));
      return raw ? JSON.parse(raw) : undefined;
    } catch (_) {
      return undefined;
    }
  }

  function writeLocalJSON(name, value) {
    try {
      window.localStorage.setItem(
        localCharacterKey(name),
        JSON.stringify(value)
      );
      return true;
    } catch (e) {
      warn(`Could not persist local fallback '${name}'.`, e);
      return false;
    }
  }

  function removeLocal(name) {
    try {
      window.localStorage.removeItem(localCharacterKey(name));
    } catch (_) {}
  }

  function vanillaIsPaperMaking() {
    const c = game.cartography;
    // CartographyActionMode.PaperMaking = 3.
    return !!c?.isActive && c.actionMode === 3;
  }

  function allDigSites() {
    // Use the natural Archaeology progression order. findNextSite() starts
    // after the current site and only wraps around once it reaches the end.
    return [...game.archaeology.actions.allObjects].sort(
      (a, b) => (a.level ?? 0) - (b.level ?? 0)
    );
  }

  function siteIsAvailable(site) {
    if (!site || !site.isDiscovered) return false;

    // ArchaeologyDigSite.isHidden describes the associated Cartography POI's
    // hidden state. It is not a safe "can this already-discovered site be used?"
    // predicate, especially for sites revealed through Archaeology items.
    try {
      if (!game.archaeology.isMasteryActionUnlocked(site)) return false;
    } catch (_) {}

    return true;
  }

  function firstImperfectMapIndex(site) {
    return site.maps.findIndex((map) => map && !map.atMaxTier);
  }

  function hasEmptySlot(site) {
    return site.maps.length < site.getMaxMaps();
  }

  function siteNeedsWork(site) {
    if (!siteIsAvailable(site)) return false;
    if (firstImperfectMapIndex(site) !== -1) return true;
    return createMissingMaps() && hasEmptySlot(site);
  }

  function findNextSite(preferAfter) {
    const sites = allDigSites().filter(siteNeedsWork);
    if (sites.length === 0) return undefined;
    if (!preferAfter) return sites[0];

    const ordered = allDigSites();
    const currentPos = ordered.indexOf(preferAfter);
    for (let offset = 1; offset <= ordered.length; offset++) {
      const site = ordered[(currentPos + offset + ordered.length) % ordered.length];
      if (siteNeedsWork(site)) return site;
    }
    return sites[0];
  }

  function selectUpgradeMap(site, index) {
    const c = game.cartography;
    const map = site?.maps?.[index];
    if (!map) return undefined;

    /*
     * Do not use the UI click callbacks for automation.
     *
     * Official typings expose these as the actual underlying mutable state:
     * - Cartography.selectedMapUpgradeDigsite
     * - ArchaeologyDigSite.selectedUpgradeIndex
     *
     * currentUpgradeMap is then derived from that state. Repeatedly returning
     * to Old Village strongly suggests the click callbacks are restoring or
     * acting on UI selection state when we resume from Paper Making.
     *
     * Set the action state directly, and only queue the corresponding renders.
     */
    c.selectedMapUpgradeDigsite = site;
    site.selectedUpgradeIndex = index;

    c.renderQueue.selectedUpgradeDigSite = true;
    c.renderQueue.selectedUpgradeMap = true;
    c.renderQueue.mapUpgradeQuantities = true;
    c.renderQueue.mapUpgradeRates = true;
    c.renderQueue.mapUpgradeActions = true;

    return site.selectedUpgradeMap;
  }

  function createMap(site) {
    const c = game.cartography;
    c.selectDigSiteOnClick(site);
    const costs = c.getMapCreationCosts(site);
    if (!costs || typeof costs.checkIfOwned !== "function" || typeof costs.consumeCosts !== "function") {
      warn(`Could not calculate map creation costs for ${site.name}.`);
      return false;
    }
    if (!costs.checkIfOwned()) return false;

    const before = site.maps.length;
    c.createNewMapForDigSite(site);
    if (site.maps.length <= before) {
      warn(`Map creation failed at ${site.name}; no costs were consumed.`);
      return false;
    }

    // Proven v0.1.5 ordering: creation must see the resources before we consume them.
    costs.consumeCosts();

    // "before" is zero-based count, so the newly created map is before + 1.
    recordOfflineMapPurchase(site, before + 1);
    return true;
  }

  function rememberUpgradeMap(map, fallbackSite) {
    if (map) {
      const site = map.digSite ?? fallbackSite;
      const index = site?.maps?.indexOf(map) ?? -1;
      if (site && index >= 0) {
        state.activeUpgradeMap = map;
        state.activeUpgradeSite = site;
        state.activeUpgradeIndex = index;
        return true;
      }
    }

    if (fallbackSite) {
      const mapFromSite = fallbackSite.selectedUpgradeMap;
      const index = fallbackSite.maps.indexOf(mapFromSite);
      if (mapFromSite && index >= 0) {
        state.activeUpgradeMap = mapFromSite;
        state.activeUpgradeSite = fallbackSite;
        state.activeUpgradeIndex = index;
        return true;
      }
    }

    return false;
  }

  function activeUpgradeTarget(cartography = game.cartography) {
    // Once upgrading has started, this exact object is our source of truth.
    const map = state.activeUpgradeMap;
    if (map?.digSite) {
      const site = map.digSite;
      const index = site.maps.indexOf(map);
      if (index >= 0) return { site, index, map };
    }

    // Compatibility fallback only for a run that began before this build was
    // loaded or before Auto Cartographer captured the target.
    const current = cartography.currentUpgradeMap;
    if (current?.digSite) {
      const site = current.digSite;
      const index = site.maps.indexOf(current);
      if (index >= 0) return { site, index, map: current };
    }

    return undefined;
  }

  function startUpgrade(site, index) {
    const c = game.cartography;
    const map = selectUpgradeMap(site, index);
    if (!map || map.atMaxTier) return false;

    if (c.currentUpgradeMap !== map) {
      warn(
        `Refusing to start map upgrade: selected ${site.name} map ${index + 1}, ` +
        `but Cartography resolved ${c.currentUpgradeMap?.digSite?.name ?? "no map"}.`
      );
      return false;
    }

    if (c.isActive) c.stop();

    const started = !!c.startUpgradingMap(site);
    if (!started) return false;

    if (c.currentUpgradeMap !== map) {
      const vanillaResolved = c.currentUpgradeMap;
      info(
        `startUpgradingMap changed target from ${site.name} map ${index + 1} ` +
        `to ${vanillaResolved?.digSite?.name ?? "unknown"}; forcing it back.`
      );

      c.selectedMapUpgradeDigsite = site;
      site.selectedUpgradeIndex = index;

      c.renderQueue.selectedUpgradeDigSite = true;
      c.renderQueue.selectedUpgradeMap = true;
      c.renderQueue.mapUpgradeQuantities = true;
      c.renderQueue.mapUpgradeRates = true;
      c.renderQueue.mapUpgradeActions = true;
    }

    if (c.currentUpgradeMap !== map) {
      const resolved = c.currentUpgradeMap;
      warn(
        `Could not force map target to ${site.name} map ${index + 1}; ` +
        `Cartography still resolves ${resolved?.digSite?.name ?? "no map"}.`
      );
      c.stop();
      try {
        notifyPlayer(
          game.cartography,
          `Auto Cartographer stopped: could not select ${site.name} map ${index + 1}`,
          "danger"
        );
      } catch (_) {}
      return false;
    }

    rememberUpgradeMap(map, site);


    return true;
  }

  function paperQuantity(recipe) {
    if (!recipe?.product) return 0;
    try { return game.bank.getQty(recipe.product); }
    catch (_) { return 0; }
  }

  function paperCosts(recipe) {
    try { return game.cartography.getPaperMakingCosts(recipe); }
    catch (_) { return undefined; }
  }

  function canAffordPaperAction(recipe) {
    const costs = paperCosts(recipe);
    try {
      return !!costs && typeof costs.checkIfOwned === "function" && costs.checkIfOwned();
    } catch (_) {
      return false;
    }
  }

  function recipeLogKey(recipe) {
    const id = String(recipe?.id ?? recipe?.localID ?? "").toLowerCase();
    for (const [key] of LOG_SETTINGS) {
      if (id.includes(key)) return key;
    }

    // Fallback: inspect the vanilla action costs and identify the first log item.
    try {
      const costs = paperCosts(recipe);
      const itemCosts = costs?.itemCosts;
      if (itemCosts && typeof itemCosts.forEach === "function") {
        let found;
        itemCosts.forEach((_qty, item) => {
          const text = `${item?.id ?? ""} ${item?.name ?? ""}`.toLowerCase();
          if (!found) {
            for (const [key] of LOG_SETTINGS) {
              if (text.includes(key)) found = key;
            }
          }
        });
        return found;
      }
    } catch (_) {}
    return undefined;
  }

  const PAPER_LOG_CONFIG_KEY = "paperLogConfigV1";

  function defaultPaperLogConfig() {
    return LOG_SETTINGS.map(([key]) => ({ key, enabled: true }));
  }

  function normalisePaperLogConfig(value) {
    const knownKeys = new Set(LOG_SETTINGS.map(([key]) => key));
    const result = [];
    const seen = new Set();

    if (Array.isArray(value)) {
      for (const entry of value) {
        const key = String(entry?.key ?? "");
        if (!knownKeys.has(key) || seen.has(key)) continue;
        result.push({ key, enabled: entry?.enabled !== false });
        seen.add(key);
      }
    }

    // New log types added by a later build are appended enabled, preserving
    // the user's existing order.
    for (const [key] of LOG_SETTINGS) {
      if (!seen.has(key)) result.push({ key, enabled: true });
    }

    return result;
  }

  function loadPaperLogConfig() {
    try {
      const raw = ctx.characterStorage.getItem(PAPER_LOG_CONFIG_KEY);
      if (raw) {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
        return normalisePaperLogConfig(parsed);
      }
    } catch (_) {}

    const local = readLocalJSON(PAPER_LOG_CONFIG_KEY);
    if (local) return normalisePaperLogConfig(local);

    return defaultPaperLogConfig();
  }

  function savePaperLogConfig(config) {
    const normalised = normalisePaperLogConfig(config);

    let primarySaved = false;
    try {
      ctx.characterStorage.setItem(
        PAPER_LOG_CONFIG_KEY,
        JSON.stringify(normalised)
      );
      primarySaved = true;
    } catch (_) {}

    const localSaved = writeLocalJSON(PAPER_LOG_CONFIG_KEY, normalised);
    return primarySaved || localSaved;
  }

  function paperLogLabel(key) {
    return LOG_SETTINGS.find(([candidate]) => candidate === key)?.[1] ?? key;
  }

  async function openPaperLogPriorityDialog() {
    if (typeof SwalLocale === "undefined") {
      notify(
        "Auto Cartographer",
        "The Paper log priority editor could not be opened."
      );
      return;
    }

    const config = loadPaperLogConfig();
    const rows = config
      .map(
        ({ key, enabled }) => `
          <div
            class="ac-log-row d-flex align-items-center border rounded p-2 mb-2"
            data-key="${key}"
            draggable="true"
            style="gap: 0.5rem; ${enabled ? "" : "opacity: 0.55;"}"
          >
            <span
              class="ac-drag-handle text-muted"
              title="Drag to reorder"
              style="cursor: grab; width: 1.25rem; text-align: center;"
              aria-hidden="true"
            >☰</span>
            <input
              class="ac-log-enabled"
              type="checkbox"
              ${enabled ? "checked" : ""}
              aria-label="Use ${paperLogLabel(key)} for Paper"
              style="width: 1.15rem; height: 1.15rem;"
            >
            <span class="flex-grow-1 text-left">${paperLogLabel(key)}</span>
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary ac-move-up"
              title="Move up"
              aria-label="Move ${paperLogLabel(key)} up"
            >↑</button>
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary ac-move-down"
              title="Move down"
              aria-label="Move ${paperLogLabel(key)} down"
            >↓</button>
          </div>
        `
      )
      .join("");

    const result = await SwalLocale.fire({
      title: "Paper log priority",
      html: `
        <div class="text-left">
          <p class="mb-2">
            Auto Cartographer tries enabled logs from top to bottom.
            Drag rows or use the arrow buttons to reorder them.
          </p>
          <p class="text-muted small mb-3">
            Untick a log to preserve it. Disabled logs stay in the list but are skipped.
          </p>
          <div id="ac-paper-log-list">${rows}</div>
          <button
            id="ac-reset-paper-logs"
            type="button"
            class="btn btn-sm btn-outline-secondary mt-1"
          >Reset to default</button>
        </div>
      `,
      showCancelButton: true,
      confirmButtonText: "Save",
      cancelButtonText: "Cancel",
      didOpen: () => {
        const list = document.getElementById("ac-paper-log-list");
        if (!list) return;

        const updateDisabledAppearance = (row) => {
          const checkbox = row.querySelector(".ac-log-enabled");
          row.style.opacity = checkbox?.checked ? "1" : "0.55";
        };

        const wireRows = () => {
          list.querySelectorAll(".ac-log-row").forEach((row) => {
            row.querySelector(".ac-log-enabled")?.addEventListener("change", () => {
              updateDisabledAppearance(row);
            });

            row.querySelector(".ac-move-up")?.addEventListener("click", () => {
              const previous = row.previousElementSibling;
              if (previous) list.insertBefore(row, previous);
            });

            row.querySelector(".ac-move-down")?.addEventListener("click", () => {
              const next = row.nextElementSibling;
              if (next) list.insertBefore(next, row);
            });

            row.addEventListener("dragstart", (event) => {
              row.classList.add("ac-dragging");
              row.style.opacity = "0.35";
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", row.dataset.key ?? "");
            });

            row.addEventListener("dragend", () => {
              row.classList.remove("ac-dragging");
              updateDisabledAppearance(row);
            });

            row.addEventListener("dragover", (event) => {
              event.preventDefault();
              const dragging = list.querySelector(".ac-dragging");
              if (!dragging || dragging === row) return;

              const rect = row.getBoundingClientRect();
              const insertAfter = event.clientY > rect.top + rect.height / 2;
              list.insertBefore(
                dragging,
                insertAfter ? row.nextElementSibling : row
              );
            });
          });
        };

        wireRows();

        document
          .getElementById("ac-reset-paper-logs")
          ?.addEventListener("click", () => {
            const byKey = new Map(
              [...list.querySelectorAll(".ac-log-row")].map((row) => [
                row.dataset.key,
                row,
              ])
            );

            for (const [key] of LOG_SETTINGS) {
              const row = byKey.get(key);
              if (!row) continue;
              const checkbox = row.querySelector(".ac-log-enabled");
              if (checkbox) checkbox.checked = true;
              row.style.opacity = "1";
              list.appendChild(row);
            }
          });
      },
      preConfirm: () => {
        const list = document.getElementById("ac-paper-log-list");
        if (!list) return defaultPaperLogConfig();

        return [...list.querySelectorAll(".ac-log-row")].map((row) => ({
          key: row.dataset.key,
          enabled: !!row.querySelector(".ac-log-enabled")?.checked,
        }));
      },
    });

    if (result.isConfirmed && Array.isArray(result.value)) {
      savePaperLogConfig(result.value);

      // If Paper Making is currently waiting for a fallback, the new ordering
      // will be used on the next tick. We deliberately do not interrupt a
      // currently affordable recipe just because the user reordered the list.
      info(
        "Paper log priority:",
        result.value
          .filter((entry) => entry.enabled)
          .map((entry) => paperLogLabel(entry.key))
          .join(" -> ") || "none enabled"
      );
    }
  }

  function recipePriority(recipe) {
    const key = recipeLogKey(recipe);
    if (!key) return Number.POSITIVE_INFINITY;

    const config = loadPaperLogConfig();
    const index = config.findIndex((entry) => entry.key === key && entry.enabled);
    return index === -1 ? Number.POSITIVE_INFINITY : index + 1;
  }

  function rankedPaperRecipes() {
    const config = loadPaperLogConfig();
    const rank = new Map(
      config
        .map((entry, index) => ({ ...entry, index }))
        .filter((entry) => entry.enabled)
        .map((entry) => [entry.key, entry.index])
    );

    return [...game.cartography.paperRecipes.allObjects]
      .map((recipe, order) => {
        const key = recipeLogKey(recipe);
        return {
          recipe,
          order,
          priority: key !== undefined && rank.has(key)
            ? rank.get(key)
            : Number.POSITIVE_INFINITY,
        };
      })
      .filter((entry) => Number.isFinite(entry.priority))
      .sort((a, b) => a.priority - b.priority || a.order - b.order)
      .map((entry) => entry.recipe);
  }

  function chooseAffordablePaperRecipe() {
    return rankedPaperRecipes().find(canAffordPaperAction);
  }

  function recoveryPayload() {
    if (!state.paperMode || !state.resumeSite) return undefined;

    return {
      siteID: state.resumeSite.id,
      index: state.resumeIndex,
      recipeID: state.paperRecipe?.id,
      startQty: state.paperStartQty,
      goalQty: currentPaperGoal(),
      savedAt: Date.now(),
    };
  }

  function persistRecovery() {
    const payload = recoveryPayload();

    if (!payload) {
      clearRecovery();
      return;
    }

    try {
      ctx.characterStorage.setItem(
        "paperRecovery",
        JSON.stringify(payload)
      );
    } catch (_) {}

    // Dev-safe fallback. Unlike local Creator Toolkit characterStorage, this
    // survives save/reload in the same browser/Steam webview.
    writeLocalJSON("paperRecoveryV1", payload);
  }

  function clearRecovery() {
    try { ctx.characterStorage.removeItem?.("paperRecovery"); } catch (_) {}
    removeLocal("paperRecoveryV1");
  }

  let internalCartographyStopDepth = 0;

  function stopCartographyInternally() {
    const c = game.cartography;
    if (!c?.isActive) return;

    internalCartographyStopDepth++;
    try {
      c.stop();
    } finally {
      internalCartographyStopDepth--;
    }
  }

  function resetPaperRecoveryRuntime() {
    state.paperMode = false;
    state.resumeSite = undefined;
    state.resumeIndex = -1;
    state.resumeMap = undefined;
    state.paperRecipe = undefined;
    state.paperStartQty = 0;
    state.paperGoalQty = 0;

    if (
      state.pendingTransition?.kind === "resumeAfterPaper" ||
      state.pendingTransition?.kind === "fallbackPaper"
    ) {
      state.pendingTransition = undefined;
    }
  }

  function cancelManagedPaperRecovery(reason) {
    const hadRecovery = state.paperMode || !!readRecoveryPayload()?.value;
    resetPaperRecoveryRuntime();
    clearRecovery();
    if (hadRecovery && reason) info(`Paper recovery cancelled: ${reason}`);
  }

  // The Paper button is a documented UI callback. If the player clicks it
  // while our managed refill is active, that is genuine manual intervention.
  // Auto Cartographer itself uses startMakingPaper(), never makePaperOnClick().
  ctx.patch(Cartography, "makePaperOnClick").before(function () {
    if (state.paperMode) {
      cancelManagedPaperRecovery("Paper Making was changed manually.");
    }
  });

  function setPaperRecipe(recipe) {
    const c = game.cartography;
    if (c.isActive) stopCartographyInternally();
    c.selectPaperRecipeOnClick(recipe);
    state.paperRecipe = recipe;
    return !!c.startMakingPaper(recipe);
  }

  function tryNextPaperRecipe() {
    const recipe = chooseAffordablePaperRecipe();
    if (!recipe) return false;

    const previous = state.paperRecipe;
    if (!setPaperRecipe(recipe)) return false;
    persistRecovery();

    if (!previous || previous.id !== recipe.id) {
      recordOfflinePaperRecipeSwitch(previous, recipe);
      info(`Paper recipe: ${recipe.name ?? recipe.id}`);
    }
    return true;
  }

  function pauseForNoPaperIngredients() {
    state.paperMode = false;
    if (game.cartography.isActive) game.cartography.stop();
    clearRecovery();
    notify(
      "Auto Cartographer paused",
      "None of the enabled Paper recipes can currently be made. Add an enabled log type, then restart map upgrading to continue."
    );
  }

  function enterPaperMode(site, index, map) {
    if (!autoMakePaper()) return false;

    // If we have the actual DigSiteMap object, trust it over all selection
    // state. DigSiteMap.digSite is an official game property.
    if (map?.digSite) {
      const exactSite = map.digSite;
      const exactIndex = exactSite.maps.indexOf(map);
      if (exactIndex >= 0) {
        site = exactSite;
        index = exactIndex;
      }
    }

    const ranked = rankedPaperRecipes();
    if (ranked.length === 0) {
      notify("Auto Cartographer paused", "All Paper log types are disabled in the mod settings.");
      return false;
    }

    // All paper recipes produce the same banked Paper item, so use any recipe
    // to establish the current quantity before choosing the affordable recipe.
    const reference = ranked[0];
    state.resumeSite = site;
    state.resumeIndex = index;
    state.resumeMap = index >= 0 ? (map ?? site?.maps?.[index]) : undefined;
    state.paperMode = true;
    state.paperStartQty = paperQuantity(reference);
    state.paperGoalQty = currentPaperGoal();

    if (!tryNextPaperRecipe()) {
      pauseForNoPaperIngredients();
      return false;
    }

    persistRecovery();
    recordOfflinePaperRefill(site, index);
    info(`Making ${refillAmount()} additional Paper, then resuming ${site.name}.`);
    return true;
  }

  function resumeAfterPaper() {
    const resumeMap = state.resumeMap;
    let site = resumeMap?.digSite ?? state.resumeSite;
    let index =
      resumeMap && site ? site.maps.indexOf(resumeMap) : state.resumeIndex;

    info(
      `Paper refill complete. Resuming ${
        site?.name ?? "unknown site"
      } map ${index >= 0 ? index + 1 : "(site processing)"}.`
    );

    state.paperMode = false;
    state.paperRecipe = undefined;
    state.resumeSite = undefined;
    state.resumeIndex = -1;
    state.resumeMap = undefined;
    state.paperStartQty = 0;
    state.paperGoalQty = 0;
    clearRecovery();

    if (!site) {
      warn("Saved resume site is missing; falling back to normal site selection.");
      queueAdvance();
      return;
    }

    if (index === -1) {
      // Sentinel used when Paper was required to buy a missing map.
      queueAdvance(site);
      return;
    }

    if (!site.maps[index] || site.maps[index].atMaxTier) {
      index = firstImperfectMapIndex(site);
    }

    if (index === -1) {
      info(`${site.name} has no imperfect maps left; advancing from that site.`);
      queueAdvance(site);
      return;
    }

    info(`Exact resume target accepted: ${site.name} map ${index + 1}.`);

    if (!startUpgrade(site, index)) {
      // The refill can legitimately be smaller than the next upgrade cost.
      if (!enterPaperMode(site, index, site.maps[index])) {
        warn(`Could not resume map upgrading at ${site.name}.`);
      }
    }
  }

  function ensureWorkAtSite(site) {
    let index = firstImperfectMapIndex(site);

    if (index !== -1) {
      if (startUpgrade(site, index)) return true;
      return enterPaperMode(site, index);
    }

    if (createMissingMaps() && hasEmptySlot(site)) {
      if (!createMap(site)) return enterPaperMode(site, -1);

      index = firstImperfectMapIndex(site);
      if (index !== -1) {
        if (startUpgrade(site, index)) return true;
        return enterPaperMode(site, index);
      }
    }
    return false;
  }

  function advance(preferAfter) {
    if (!enabled() || state.busy || state.paperMode) return;
    state.busy = true;
    try {
      let site = preferAfter;
      if (siteNeedsWork(site) && ensureWorkAtSite(site)) return;

      site = findNextSite(preferAfter);
      if (site) {
        recordOfflineSiteMove(preferAfter, site);
        if (ensureWorkAtSite(site)) return;
      }

      if (isOfflineProcessing()) offlineReport.finishedAllWork = true;
      notify("Auto Cartographer finished", "Every currently available dig-site map slot is Perfect.");
    } finally {
      state.busy = false;
    }
  }

  const TRANSITION_PRIORITY = {
    advance: 10,
    enterPaper: 20,
    fallbackPaper: 30,
    restartOwnedPaper: 35,
    resumeAfterPaper: 40,
  };

  function requestTransition(kind, data = {}) {
    const next = { kind, ...data };
    const current = state.pendingTransition;

    // One transition is enough per game tick. If multiple hooks fire in the
    // same tick, keep the one that represents the more specific recovery state.
    if (
      !current ||
      (TRANSITION_PRIORITY[next.kind] ?? 0) >=
        (TRANSITION_PRIORITY[current.kind] ?? 0)
    ) {
      state.pendingTransition = next;
    }
  }

  function queueAdvance(preferAfter) {
    requestTransition("advance", { site: preferAfter });
  }

  function flushPendingTransition() {
    const transition = state.pendingTransition;
    if (!transition) return;

    // Consume first. If executing this transition causes another hook to
    // request work, that new request remains queued for the next Game.tick.
    state.pendingTransition = undefined;

    try {
      switch (transition.kind) {
        case "advance":
          advance(transition.site);
          break;

        case "enterPaper":
          if (!state.paperMode) {
            enterPaperMode(transition.site, transition.index, transition.map);
          }
          break;

        case "fallbackPaper":
          if (state.paperMode && !tryNextPaperRecipe()) {
            pauseForNoPaperIngredients();
          }
          break;

        case "restartOwnedPaper":
          if (state.paperMode) {
            const c = game.cartography;

            // Loading can temporarily leave Cartography in None/stopped even
            // though our persisted recovery record says we own a Paper refill.
            if (!c.isActive || c.actionMode === 0) {
              if (!tryNextPaperRecipe()) {
                pauseForNoPaperIngredients();
              } else {
                info("Restarted managed Paper Making after save restore.");
              }
            } else if (c.actionMode !== 3) {
              // A genuinely active different mode wins: the player/game has
              // moved on, so do not hijack it.
              cancelManagedPaperRecovery(
                "another Cartography action is active."
              );
            }
          }
          break;

        case "resumeAfterPaper":
          if (state.paperMode) {
            if (game.cartography.isActive) stopCartographyInternally();
            resumeAfterPaper();
          }
          break;
      }
    } catch (e) {
      warn(`Transition ${transition.kind} failed.`, e);
    }
  }

  function findDigSiteByID(id) {
    if (!id) return undefined;
    try {
      if (typeof game.archaeology.actions.getObjectByID === "function")
        return game.archaeology.actions.getObjectByID(id);
    } catch (_) {}
    return game.archaeology.actions.allObjects.find((site) => site.id === id);
  }

  function findPaperRecipeByID(id) {
    if (!id) return undefined;
    try {
      if (typeof game.cartography.paperRecipes.getObjectByID === "function")
        return game.cartography.paperRecipes.getObjectByID(id);
    } catch (_) {}
    return game.cartography.paperRecipes.allObjects.find((recipe) => recipe.id === id);
  }

  function readRecoveryPayload() {
    // Primary store for a normally installed/published mod.
    try {
      const raw = ctx.characterStorage.getItem("paperRecovery");
      if (raw) return {
        source: "characterStorage",
        value: typeof raw === "string" ? JSON.parse(raw) : raw,
      };
    } catch (_) {}

    // Creator Toolkit fallback.
    const local = readLocalJSON("paperRecoveryV1");
    if (local) return { source: "localStorage", value: local };

    return undefined;
  }

  function restoreRecoveryPayload(stored) {
    if (!stored?.value) return false;

    try {
      const saved = stored.value;
      const site = findDigSiteByID(saved.siteID);
      if (!site) return false;

      state.resumeSite = site;
      state.resumeIndex =
        Number.isInteger(saved.index) ? saved.index : -1;
      state.resumeMap =
        state.resumeIndex >= 0 ? site.maps[state.resumeIndex] : undefined;
      state.paperMode = true;
      state.paperStartQty = Number.isFinite(Number(saved.startQty))
        ? Math.max(0, Number(saved.startQty))
        : Math.max(
            0,
            (Number(saved.goalQty) || refillAmount()) - refillAmount()
          );
      state.paperGoalQty = currentPaperGoal();
      state.paperRecipe = findPaperRecipeByID(saved.recipeID);

      const reference = state.paperRecipe ?? rankedPaperRecipes()[0];
      if (!reference) {
        cancelManagedPaperRecovery("no enabled Paper recipe is available.");
        return false;
      }

      const c = game.cartography;
      const paper = paperQuantity(reference);

      if (paper >= state.paperGoalQty) {
        requestTransition("resumeAfterPaper");
      } else if (c?.isActive && c.actionMode === 3) {
        // Vanilla successfully restored the Paper action. Only intervene if
        // that recipe can no longer perform another action.
        if (
          !state.paperRecipe ||
          !canAffordPaperAction(state.paperRecipe)
        ) {
          requestTransition("fallbackPaper");
        }
      } else if (!c?.isActive || c.actionMode === 0) {
        // This is the v0.3.11 failure mode: the ownership record survived, but
        // vanilla restored Cartography as stopped. The record is authoritative,
        // so restart the managed Paper action at the tick boundary.
        requestTransition("restartOwnedPaper");
      } else {
        // A real active non-Paper Cartography action is stronger evidence of
        // user intervention (or a successfully completed stale recovery).
        cancelManagedPaperRecovery(
          "another Cartography action is already active."
        );
        return false;
      }

      // Refresh both persistence backends after resolving live object IDs.
      persistRecovery();

      info(
        `Recovered managed Paper refill for ${site.name} ` +
        `from ${stored.source}; Paper ${paper}/${state.paperGoalQty}.`
      );
      return true;
    } catch (e) {
      warn("Stored Paper recovery state was invalid.", e);
      resetPaperRecoveryRuntime();
      return false;
    }
  }

  function restoreRecoveryState() {
    if (state.paperMode) return true;

    const stored = readRecoveryPayload();
    if (!stored?.value) return false;

    // Ownership comes from our persisted record, not from whether vanilla
    // happened to restore the temporary Paper action. This is the key fix for
    // saves that load with Cartography stopped.
    return restoreRecoveryPayload(stored);
  }


  // Capture the exact intended map from the actual startUpgradingMap(digSite)
  // call. Using replace lets us snapshot digSite.selectedUpgradeMap before
  // vanilla mutates any Cartography selection/action state.
  ctx.patch(Cartography, "startUpgradingMap").replace(function (original, digSite) {
    const intendedMap = digSite?.selectedUpgradeMap;
    const started = original(digSite);
    if (started && intendedMap) rememberUpgradeMap(intendedMap, digSite);
    return started;
  });

  /*
   * Do NOT update state.activeUpgradeMap from the upgradeMap event or
   * getMapUpgradeCosts().
   *
   * v0.2.11-v0.2.13 proved that the intended map is correctly remembered
   * through Paper recovery, but the running target later jumps to Old Village.
   * The only code that was allowed to overwrite our remembered map after
   * startup was these derived/event callbacks. The map being worked does not
   * change during an upgrade run, so the map captured by startUpgrade() remains
   * authoritative until we deliberately start another map.
   */
  /*
   * Keep the exact DigSiteMap locked in immediately before every vanilla map
   * upgrade action.
   *
   * v0.2.11/v0.2.12 proved that the correct Sacrificial Site map survives:
   *   save -> resume -> startUpgradingMap()
   * yet the subsequent actions still modify Old Village.
   *
   * That means the target is drifting after startup, before the next
   * mapUpgradeAction() consumes its costs/progress. Re-asserting the exact map
   * here is the last safe boundary before vanilla performs the upgrade.
   */
  ctx.patch(Cartography, "mapUpgradeAction").replace(function (original) {
    let reportMap;
    let beforeActions;
    let beforeTierName;

    if (enabled() && !state.paperMode && state.activeUpgradeMap?.digSite) {
      const map = state.activeUpgradeMap;
      const site = map.digSite;
      const index = site.maps.indexOf(map);

      if (index >= 0 && !map.atMaxTier) {
        const drifted = this.currentUpgradeMap !== map;

        this.selectedMapUpgradeDigsite = site;
        site.selectedUpgradeIndex = index;

        if (this.currentUpgradeMap !== map) {
          warn(
            `Map target could not be locked to ${site.name} map ${index + 1}; ` +
            `vanilla resolves ${this.currentUpgradeMap?.digSite?.name ?? "no map"}.`
          );
          this.stop();
          return;
        }

        if (drifted) {
          info(`Corrected map target drift back to ${site.name} map ${index + 1}.`);
        }

        if (isOfflineProcessing()) {
          reportMap = map;
          beforeActions = map.upgradeActions;
          beforeTierName = map.tier?.name;
        }
      }
    }

    const result = original();

    // Count only a real change to upgradeActions. A failed/empty callback
    // cannot inflate the recap.
    if (
      reportMap &&
      Number.isFinite(beforeActions) &&
      reportMap.upgradeActions > beforeActions
    ) {
      recordOfflineMapUpgrade(
        reportMap,
        reportMap.upgradeActions - beforeActions,
        beforeTierName
      );
    }

    return result;
  });

  ctx.patch(Cartography, "mapUpgradeAction").after(function (_ret) {
    if (!enabled() || state.paperMode) return;

    const map = state.activeUpgradeMap;
    if (map?.atMaxTier) {
      queueAdvance(map.digSite);
    }
  });

  ctx.patch(Cartography, "paperMakingAction").after(function (_ret) {
    if (!enabled() || !state.paperMode) return;

    const recipe = state.paperRecipe;
    if (!recipe) return;

    // Re-read the setting on every completed Paper action. If the user changes
    // the refill amount while recovery is already running, the current cycle
    // immediately adopts the new target.
    state.paperGoalQty = currentPaperGoal();
    if (paperQuantity(recipe) >= state.paperGoalQty) {
      requestTransition("resumeAfterPaper");
      return;
    }

    // v0.1.6 safety guard, extended with recipe fallback. Do not switch
    // recipes from inside Cartography.action(); defer only until Game.tick
    // has returned, which also works during Melvor's offline tick loop.
    if (!canAffordPaperAction(recipe)) {
      requestTransition("fallbackPaper");
    }
  });

  ctx.patch(Cartography, "paperIngredientNotify").after(function (_ret) {
    if (!state.paperMode) return;
    requestTransition("fallbackPaper");
  });

  ctx.patch(Cartography, "mapIngredientNotify").after(function (_ret) {
    if (!enabled() || state.paperMode || !autoMakePaper()) return;

    const target = activeUpgradeTarget(this);

    if (!target) {
      warn("Map ran out of ingredients, but the exact active map could not be resolved.");
      return;
    }

    info(`Paper shortage while upgrading ${target.site.name} map ${target.index + 1}.`);

    requestTransition("enterPaper", {
      site: target.site,
      index: target.index,
      map: target.map,
    });
  });

  // Critical architectural piece:
  // Action Workflows (a production Melvor automation mod) uses
  // ctx.patch(Game, "tick").after(...) as its "tick end" signal, then changes
  // actions only after that boundary. This avoids mutating an ActiveAction
  // from inside its own Cartography.action() call, while still executing
  // between simulated offline ticks (unlike setTimeout).
  ctx.patch(Game, "tick").after(function (_ret) {
    if (enabled()) {
      if (!state.paperMode && readRecoveryPayload()?.value) {
        restoreRecoveryState();
      }

      const c = game.cartography;
      if (
        state.paperMode &&
        c?.isActive &&
        c.actionMode !== 0 &&
        c.actionMode !== 3
      ) {
        cancelManagedPaperRecovery("another Cartography action is active.");
      }
    }

    flushPendingTransition();
  });

  game.on("offlineLoopEntered", () => {
    if (enabled() && !state.paperMode && readRecoveryPayload()?.value) {
      restoreRecoveryState();
    }
  });

  if (typeof ctx.onCharacterLoaded === "function") {
    ctx.onCharacterLoaded(() => restoreRecoveryState());
  }

  if (typeof ctx.onInterfaceReady === "function") {
    ctx.onInterfaceReady(() => restoreRecoveryState());
  }

  game.on("offlineLoopEntered", () => {
    if (!offlineReport.snapshotPrepared) {
      prepareOfflineReportFromVanillaSnapshot(game.cartography);
    }
    offlineReport.active = enabled();
  });

  game.on("offlineLoopExited", () => {
    offlineReport.active = false;
  });

  /*
   * Melvor's OfflineProgressElement.setMessages() calls
   * offlineAction.getOfflineMessages() and appends those strings to the normal
   * recap. v0.3.3 already proved this route appears with Better Offline Recap,
   * so use it rather than touching recap DOM or depending on that mod's internals.
   */
  ctx.patch(Cartography, "getOfflineMessages").replace(function (original) {
    const vanillaMessages = original();
    const supplemental = buildSupplementalOfflineMessages();

    return supplemental.length === 0
      ? vanillaMessages
      : [...vanillaMessages, ...supplemental];
  });

  ctx.api({
    start() {
      const current = game.cartography.selectedMapUpgradeDigsite;
      advance(current);
    },
    stop() {
      state.pendingTransition = undefined;
      cancelManagedPaperRecovery();
      if (game.cartography.isActive) stopCartographyInternally();
      info("Stopped.");
    },
    status() {
      return {
        enabled: enabled(),
        createMissingMaps: createMissingMaps(),
        autoMakePaper: autoMakePaper(),
        refillAmount: refillAmount(),
        paperRecipes: rankedPaperRecipes().map((r) => ({
          id: r.id,
          name: r.name,
          log: recipeLogKey(r),
          priority: recipePriority(r),
          affordable: canAffordPaperAction(r),
        })),
        state: {
          busy: state.busy,
          paperMode: state.paperMode,
          resumeSiteName: state.resumeMap?.digSite?.name ?? state.resumeSite?.name,
          resumeIndex:
            state.resumeMap?.digSite?.maps?.indexOf(state.resumeMap) ??
            state.resumeIndex,
          paperRecipeName: state.paperRecipe?.name,
          paperStartQty: state.paperStartQty,
          paperGoalQty: state.paperGoalQty,
          pendingTransition: state.pendingTransition?.kind,
          persistedRecovery: !!readRecoveryPayload()?.value,
          activeUpgradeSiteName: state.activeUpgradeMap?.digSite?.name ??
            state.activeUpgradeSite?.name,
          activeUpgradeIndex: state.activeUpgradeMap?.digSite
            ? state.activeUpgradeMap.digSite.maps.indexOf(state.activeUpgradeMap)
            : state.activeUpgradeIndex,
        },
      };
    },
  });

  info("v1.0.0 loaded. Configure it from Auto Cartographer's mod settings.");
}
