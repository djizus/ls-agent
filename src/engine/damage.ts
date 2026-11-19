import type { Adventurer, Item } from "../codec.ts";
import { MIN_DAMAGE_FROM_BEAST, MIN_DAMAGE_TO_BEAST, armorValue, greatness, weaponAttack, type Hit } from "../combat.ts";
import { itemOf, type ItemType } from "../items.ts";
import { specialsOf } from "./specials.ts";

export type Foe = { level: number; tier: number; type: "Magic" | "Blade" | "Bludgeon"; prefix: number | null; suffix: number | null };

const STRONG: Record<string, ItemType> = { Magic: "Metal", Blade: "Cloth", Bludgeon: "Hide" };
const WEAK: Record<string, ItemType> = { Magic: "Hide", Blade: "Metal", Bludgeon: "Cloth" };
const ARMOR: Record<Foe["type"], ItemType> = { Magic: "Cloth", Blade: "Hide", Bludgeon: "Metal" };
export const NECK: Partial<Record<ItemType, string>> = { Cloth: "Amulet", Hide: "Pendant", Metal: "Necklace" };

const typeOf = (item: Item): ItemType | undefined => (item.id ? itemOf(item.id)!.type : undefined);
const named = (item: Item, name: string): boolean => !!item.id && itemOf(item.id)!.name === name;
const percent = (value: number, item: Item): number => Math.floor((value * 3 * greatness(item)) / 100);

export function typed(attack: number, weapon: ItemType | undefined, armor: ItemType | undefined): number {
  const shift = Math.floor(attack / 2);
  if (weapon !== "Magic" && weapon !== "Blade" && weapon !== "Bludgeon") return attack;
  if (!armor || STRONG[weapon] === armor) return attack + shift;
  return WEAK[weapon] === armor ? attack - shift : attack;
}

function nameBonus(item: Item, foe: Foe, attack: number, salt: number, gameId: bigint, prefixWeight: number, suffixWeight: number): number {
  const specials = specialsOf(item, salt, gameId);
  if (!specials) return 0;
  return (specials.prefix === foe.prefix ? attack * prefixWeight : 0) + (specials.suffix === foe.suffix ? attack * suffixWeight : 0);
}

export function yourHit(adventurer: Adventurer, strength: number, foe: Foe, gameId: bigint): Hit {
  const { weapon, ring } = adventurer.equipment;
  const armor = foe.level * (6 - foe.tier);
  const attack = typed(weaponAttack(weapon), typeOf(weapon), ARMOR[foe.type]);
  const bonus = Math.floor((attack * strength) / 10);
  const names = foe.prefix === null ? 0 : nameBonus(weapon, foe, attack, adventurer.item_specials_salt, gameId, 8, 2);
  const land = (total: number) => (total > armor + MIN_DAMAGE_TO_BEAST ? total - armor : MIN_DAMAGE_TO_BEAST);
  const platinum = named(ring, "Platinum Ring") && names > 0 ? percent(names, ring) : 0;
  const titanium = named(ring, "Titanium Ring") && attack > 0 ? percent(attack, ring) : 0;
  return { normal: land(attack + bonus + names) + platinum, crit: land(2 * attack + bonus + names) + platinum + titanium };
}

export const neckBonus = (armor: Item, neck: Item): number =>
  armor.id && named(neck, NECK[typeOf(armor)!] ?? "") ? percent(armorValue(armor), neck) : 0;

export function beastHit(adventurer: Adventurer, foe: Foe, armor: Item, gameId: bigint): Hit {
  const power = foe.level * (6 - foe.tier);
  if (!armor.id) {
    const hit = power + Math.floor(power / 2);
    return { normal: Math.max(MIN_DAMAGE_FROM_BEAST, hit), crit: Math.max(MIN_DAMAGE_FROM_BEAST, hit * 2) };
  }
  const attack = typed(power, foe.type, typeOf(armor));
  const names = foe.prefix !== null && foe.suffix !== null ? nameBonus(armor, foe, attack, adventurer.item_specials_salt, gameId, 8, 2) : 0;
  const defense = armorValue(armor);
  const neck = neckBonus(armor, adventurer.equipment.neck);
  const land = (total: number) => Math.max(MIN_DAMAGE_FROM_BEAST, Math.max(MIN_DAMAGE_FROM_BEAST, total - defense) - neck);
  return { normal: land(attack + names), crit: land(2 * attack + names) };
}

export function obstacleHit(foe: Foe, armor: Item, neck: Item, critical: boolean): number {
  const attack = typed(foe.level * (6 - foe.tier), foe.type, typeOf(armor)) * (critical ? 2 : 1);
  const damage = Math.max(MIN_DAMAGE_TO_BEAST, attack - armorValue(armor));
  return Math.max(MIN_DAMAGE_TO_BEAST, damage - neckBonus(armor, neck));
}

export const reduced = (damage: number, percent: number): number => Math.floor((damage * (100 - percent)) / 100);

export const goldReward = (foe: Foe, ring: Item): number => {
  const gold = Math.floor((foe.level * (6 - foe.tier)) / 2);
  return named(ring, "Gold Ring") && gold > 0 ? gold + percent(gold, ring) : gold;
};

export const xpReward = (foe: Foe, level: number): number =>
  Math.max(4, Math.floor((Math.floor(((6 - foe.tier) * foe.level) / 2) * (100 - Math.min(level * 2, 95))) / 100));
