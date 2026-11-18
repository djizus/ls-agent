export const MECHANICS = [
  "The market is open whenever you are not in battle. Stat points must be spent before exploring or buying potions; doing it first in the same decision works.",
  "A potion heals 10 HP, up to max health; buying one at full health is rejected.",
  "Max health is 100 + 15 x VIT. Each VIT point raises max health by 15 and heals 15 HP immediately.",
  "Item prices fall by 1 gold per point of CHA, to a minimum of 1.",
  "Attack and flee without a threshold continue until the fight ends: the beast dies, you escape, or you die.",
  "Each flee try succeeds with chance DEX / level (always when DEX is at least your level); with DEX 0 you cannot flee.",
  "Weapon attack is greatness x (6 - tier), so a T1 weapon hits 5x harder than a T5 at equal greatness. Damage is that attack minus the beast's armor (beast level x (6 - beast tier)), with a minimum of 4.",
  "Each STR point adds 10% of the weapon's attack (rounded down), before beast armor is subtracted.",
  "Blade weapons deal +50% to Magic beasts, Bludgeon to Blade beasts, Magic to Bludgeon beasts; the reverse pairing (Blade vs Bludgeon, Bludgeon vs Magic, Magic vs Blade) deals -50%.",
  "Magic beasts wear Cloth, Blade beasts Hide, Bludgeon beasts Metal. Beasts hit an empty armor slot for 1.5x their attack; armor of the type their weapon beats also takes 1.5x, and armor that beats it halves the hit.",
  "A beast's level is random up to three times yours, plus 10, 20, 40 or 80 once you reach level 20, 30, 40 or 50.",
];
