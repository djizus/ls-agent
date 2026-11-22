import type { Beast } from "./beast.ts";
import type { Item, Stats } from "./codec.ts";
import { itemOf, levelOf, type ItemType } from "./items.ts";

export type Hit = { normal: number; crit: number };
type Kind = Beast["type"];

export const MAX_GREATNESS = 20;
export const MIN_DAMAGE_TO_BEAST = 4;
export const MIN_DAMAGE_FROM_BEAST = 2;

const BEATS: Record<Kind, Kind> = { Blade: "Magic", Bludgeon: "Blade", Magic: "Bludgeon" };
const KIND_OF: Partial<Record<ItemType, Kind>> = { Magic: "Magic", Cloth: "Magic", Blade: "Blade", Hide: "Blade", Bludgeon: "Bludgeon", Metal: "Bludgeon" };

export const greatness = (item: Item): number => Math.min(MAX_GREATNESS, levelOf(item.xp));

const power = (level: number, tier: number): number => level * (6 - tier);

const itemPower = (item: Item | undefined): number => {
  const loot = item?.id ? itemOf(item.id) : undefined;
  return item && loot ? power(greatness(item), loot.tier) : 0;
};

export const weaponAttack = itemPower;
export const armorValue = itemPower;
const beastPower = (beast: Beast): number => power(beast.level, beast.tier);

const kindOf = (item: Item | undefined): Kind | undefined => (item?.id ? KIND_OF[itemOf(item.id)!.type] : undefined);

function typed(attack: number, weapon: Kind | undefined, armor: Kind | undefined): number {
  const shift = Math.floor(attack / 2);
  if (!weapon) return attack;
  if (!armor || BEATS[weapon] === armor) return attack + shift;
  return BEATS[armor] === weapon ? attack - shift : attack;
}

function landed(attack: number, bonus: number, armor: number, minimum: number): Hit {
  const land = (total: number) => (total > armor + minimum ? total - armor : minimum);
  return { normal: land(attack + bonus), crit: land(2 * attack + bonus) };
}

export function yourHit(weapon: Item | undefined, stats: Stats, beast: Beast): Hit {
  const attack = typed(weaponAttack(weapon), kindOf(weapon), beast.type);
  return landed(attack, Math.floor((attack * stats.strength) / 10), beastPower(beast), MIN_DAMAGE_TO_BEAST);
}

export function beastHit(beast: Beast, armor: Item | undefined): Hit {
  return landed(typed(beastPower(beast), beast.type, kindOf(armor)), 0, armorValue(armor), MIN_DAMAGE_FROM_BEAST);
}
