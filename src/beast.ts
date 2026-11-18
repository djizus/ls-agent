import { levelOf } from "./items.ts";
import { hash } from "starknet";
import type { Adventurer } from "./codec.ts";

export type Beast = {
  id: number;
  name: string;
  baseName: string;
  tier: number;
  type: "Magic" | "Blade" | "Bludgeon";
  level: number;
  health: number;
  specialPrefix: string | null;
  specialSuffix: string | null;
  isCollectable: boolean;
};

const PREFIXES = "Agony Apocalypse Armageddon Beast Behemoth Blight Blood Bramble Brimstone Brood Carrion Cataclysm Chimeric Corpse Corruption Damnation Death Demon Dire Dragon Dread Doom Dusk Eagle Empyrean Fate Foe Gale Ghoul Gloom Glyph Golem Grim Hate Havoc Honour Horror Hypnotic Kraken Loath Maelstrom Mind Miracle Morbid Oblivion Onslaught Pain Pandemonium Phoenix Plague Rage Rapture Rune Skull Sol Soul Sorrow Spirit Storm Tempest Torment Vengeance Victory Viper Vortex Woe Wrath Lights Shimmering".split(" ");
const SUFFIXES = "Bane Root Bite Song Roar Grasp Instrument Glow Bender Shadow Whisper Shout Growl Tear Peak Form Sun Moon".split(" ");
const NAMES = "Warlock Typhon Jiangshi Anansi Basilisk Gorgon Kitsune Lich Chimera Wendigo Rakshasa Werewolf Banshee Draugr Vampire Goblin Ghoul Wraith Sprite Kappa Fairy Leprechaun Kelpie Pixie Gnome Griffin Manticore Phoenix Dragon Minotaur Qilin Ammit Nue Skinwalker Chupacabra Weretiger Wyvern Roc Harpy Pegasus Hippogriff Fenrir Jaguar Satori Direwolf Bear Wolf Mantis Spider Rat Kraken Colossus Balrog Leviathan Tarrasque Titan Nephilim Behemoth Hydra Juggernaut Oni Jotunn Ettin Cyclops Giant Nemeanlion Berserker Yeti Golem Ent Troll Bigfoot Ogre Orc Skeleton".split(" ");

const poseidon = (values: bigint[]) => BigInt(hash.computePoseidonHashOnElements(values));


function bonus(level: number): number {
  if (level >= 50) return 80;
  if (level >= 40) return 40;
  if (level >= 30) return 20;
  if (level >= 20) return 10;
  return 0;
}

export function beastOf(adventurer: Adventurer, gameId: bigint): Beast | null {
  if (adventurer.beast_health === 0) return null;
  const { xp } = adventurer;
  const seed = poseidon([BigInt(adventurer.beast_salt), gameId, BigInt(xp)]) % (1n << 64n);
  const rnd = poseidon([BigInt(xp), seed]) & ((1n << 128n) - 1n);
  const kind = rnd >> 96n;
  const levelRoll = Number((rnd >> 32n) & 0xffffn);
  const prefixRoll = Number((rnd >> 24n) & 0xffn);
  const suffixRoll = Number((rnd >> 16n) & 0xffn);
  const id = Number((kind % 15n) * 5n + ((kind / 15n) % 5n) + 1n);
  const adventurerLevel = levelOf(xp);
  const level = 1 + (levelRoll % (adventurerLevel * 3)) + bonus(adventurerLevel);
  const baseName = NAMES[id - 1];
  const special = level >= 19;
  const specialPrefix = special ? PREFIXES[prefixRoll % 69] : null;
  const specialSuffix = special ? SUFFIXES[suffixRoll % 18] : null;
  return {
    id,
    name: special ? `"${specialPrefix} ${specialSuffix}" ${baseName}` : baseName,
    baseName,
    tier: Math.floor(((id - 1) % 25) / 5) + 1,
    type: id <= 25 ? "Magic" : id <= 50 ? "Blade" : "Bludgeon",
    level,
    health: adventurer.beast_health,
    specialPrefix,
    specialSuffix,
    isCollectable: false,
  };
}
