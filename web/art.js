const ART = "https://lootsurvivor.io";
const LOOT_DUNGEON_BEASTS = "https://cdn.jsdelivr.net/npm/@provable-games/collectables@0.11.0/images/beasts/static/regular";

const at = (path) => `${ART}${path}`;

export const icon = {
  favicon: at("/favicon.png"),
  logo: at("/images/mobile/logo.png"),
  bag: at("/images/inventory.png"),
  skull: at("/images/skull.png"),
  gold: at("/images/mobile/gold.png"),
  potion: at("/images/life-potion.png"),
  dungeon_ticket: at("/images/dungeon_ticket.png"),
  survivor_token: at("/images/survivor_token.png"),
};

export const beastArt = (name, collection) => (collection === "lootBag" ? `${LOOT_DUNGEON_BEASTS}/${name.toLowerCase()}.png` : at(`/images/beasts/${name.toLowerCase()}.png`));
export const lootArt = (name) => at(`/images/loot/${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}.png`);
export const statArt = (name) => at(`/images/types/${name[0].toUpperCase()}${name.slice(1)}.svg`);
