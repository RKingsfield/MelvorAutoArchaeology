export function setupGeneralSettings(
  ctx,
  restockOptions = [],
  defaultRestockTargets = [],
  onModeChange = () => {},
  onRestockTargetsChange = () => {}
) {
  const GENERAL = ctx.settings.section("General");

  GENERAL.add({
    type: "switch",
    name: "enabled",
    label: "Enable Auto Archaeology",
    hint: "Automatically manage Archaeology maps, sites and tools according to the selected mode.",
    default: true,
  });

  GENERAL.add({
    type: "dropdown",
    name: "mode-v100rc1",
    label: "Mode",
    hint: "Discovery hunts permanently undiscovered artefacts. Restock farms selected Archaeology consumables. Use All Maps burns every charged Archaeology map. All modes safely circle the dig-site list before stopping.",
    default: "discovery",
    color: "primary",
    options: [
      { value: "continue", display: "Use All Maps" },
      { value: "discovery", display: "Discovery" },
      { value: "restock", display: "Restock" },
    ],
    onChange(value, previousValue) {
      onModeChange(value, previousValue);
    },
  });

  const RESTOCK = ctx.settings.section("Restock Mode");

  RESTOCK.add({
    type: "checkbox-group",
    name: "restock-targets-v100rc1",
    label: "Consumables to restock",
    hint: "Select the Archaeology consumables to farm. Restock enables only relevant artefact sizes and visits every charged source site before stopping.",
    default: defaultRestockTargets,
    options: restockOptions,
    onChange(value, previousValue) {
      onRestockTargetsChange(value, previousValue);
    },
  });

  return { GENERAL, RESTOCK };
}
