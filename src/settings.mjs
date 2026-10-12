export const LOG_SETTINGS = [
  ["normal", "Normal Logs"],
  ["oak", "Oak Logs"],
  ["teak", "Teak Logs"],
  ["mahogany", "Mahogany Logs"],
  ["maple", "Maple Logs"],
  ["yew", "Yew Logs"],
  ["magic", "Magic Logs"],
];

export function setupGeneralSettings(ctx, onConfigurePaperLogs) {
  const GENERAL = ctx.settings.section("General");
  const PAPER = ctx.settings.section("Paper Production");

  GENERAL.add({
    type: "switch",
    name: "enabled",
    label: "Enable Auto Cartographer",
    hint: "Automatically continue through maps and dig sites when a map reaches Perfect.",
    default: true,
  });

  GENERAL.add({
    type: "switch",
    name: "create-missing-maps",
    label: "Automatically create missing maps",
    hint: "Fill empty map slots using the normal vanilla map-creation cost.",
    default: true,
  });

  PAPER.add({
    type: "switch",
    name: "auto-make-paper",
    label: "Automatically make Paper when required",
    hint: "Temporarily switch Cartography to Paper Making, then return to the interrupted map.",
    default: true,
  });

  PAPER.add({
    type: "number",
    name: "paper-refill-amount",
    label: "Paper to make per refill",
    hint: "How much additional Paper to make when Auto Cartographer runs out. Changes apply to a refill already in progress. Default: 1000.",
    default: 1000,
  });

  // Current production Melvor mods use the native settings button type.
  PAPER.add({
    type: "button",
    name: "configure-paper-logs",
    display: "Configure",
    label: "Paper log priority",
    onClick() {
      onConfigurePaperLogs();
    },
  });

  return { GENERAL, PAPER, LOG_SETTINGS };
}
