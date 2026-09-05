// Recipes, and what you need to be standing next to to use them.
//
// There is no crafting grid. A grid is a puzzle about remembering shapes, and
// the interesting decision here is which of the things you could make is worth
// the ore - so recipes are a list, and the list tells you what you are short of.

import { blockItem } from './items.js';

const PLANKS = blockItem(9);
const COBBLE = blockItem(10);
const SAND = blockItem(4);
const GRAVEL = blockItem(5);
const CLAY = blockItem(16);
const GLASS = blockItem(12);
const BRICK = blockItem(11);
const CONCRETE = blockItem(14);
const WOOD = blockItem(7);
const BENCH = blockItem(21);
const FURNACE = blockItem(22);

/**
 * `station` is the block you must be standing within a few metres of:
 * null anywhere, 'bench' at a workbench, 'furnace' at a furnace. Everything
 * past the first few recipes needs one, which is what turns a pile of
 * materials into a reason to build somewhere to put them.
 */
export const RECIPES = [
  // --- by hand -----------------------------------------------------------
  { id: 'planks', out: PLANKS, count: 4, station: null, needs: [[WOOD, 1]], note: 'Split a log' },
  { id: 'sticks', out: 'stick', count: 4, station: null, needs: [[PLANKS, 2]] },
  { id: 'bench', out: BENCH, count: 1, station: null, needs: [[PLANKS, 4]], note: 'Unlocks most of this list' },
  { id: 'furnace', out: FURNACE, count: 1, station: null, needs: [[COBBLE, 8]], note: 'Smelts ore' },

  // --- smelting ----------------------------------------------------------
  { id: 'iron_ingot', out: 'iron_ingot', count: 1, station: 'furnace', needs: [['iron_ore', 1], ['coal', 1]] },
  { id: 'copper_ingot', out: 'copper_ingot', count: 1, station: 'furnace', needs: [['copper_ore', 1], ['coal', 1]] },
  { id: 'gold_ingot', out: 'gold_ingot', count: 1, station: 'furnace', needs: [['gold_ore', 1], ['coal', 1]] },
  { id: 'glass', out: GLASS, count: 1, station: 'furnace', needs: [[SAND, 1], ['coal', 1]] },
  { id: 'brick', out: BRICK, count: 2, station: 'furnace', needs: [[CLAY, 4], ['coal', 1]] },

  // --- digging tools -----------------------------------------------------
  { id: 'pickaxe_wood', out: 'pickaxe_wood', count: 1, station: null, needs: [[PLANKS, 3], ['stick', 2]] },
  { id: 'shovel_wood', out: 'shovel_wood', count: 1, station: null, needs: [[PLANKS, 1], ['stick', 2]] },
  { id: 'axe_wood', out: 'axe_wood', count: 1, station: null, needs: [[PLANKS, 3], ['stick', 2]] },
  { id: 'pickaxe_stone', out: 'pickaxe_stone', count: 1, station: 'bench', needs: [[COBBLE, 3], ['stick', 2]] },
  { id: 'shovel_stone', out: 'shovel_stone', count: 1, station: 'bench', needs: [[COBBLE, 1], ['stick', 2]] },
  { id: 'axe_stone', out: 'axe_stone', count: 1, station: 'bench', needs: [[COBBLE, 3], ['stick', 2]] },
  { id: 'pickaxe_iron', out: 'pickaxe_iron', count: 1, station: 'bench', needs: [['iron_ingot', 3], ['stick', 2]], note: 'Takes gold ore home' },
  { id: 'shovel_iron', out: 'shovel_iron', count: 1, station: 'bench', needs: [['iron_ingot', 1], ['stick', 2]] },
  { id: 'axe_iron', out: 'axe_iron', count: 1, station: 'bench', needs: [['iron_ingot', 3], ['stick', 2]] },

  // --- melee -------------------------------------------------------------
  { id: 'machete', out: 'machete', count: 1, station: 'bench', needs: [['iron_ingot', 2], ['stick', 1]], note: 'Clears undergrowth in one swing' },
  { id: 'sledgehammer', out: 'sledgehammer', count: 1, station: 'bench', needs: [['iron_ingot', 5], ['stick', 3]], note: 'Breaks a three-by-three' },

  // --- base building -----------------------------------------------------
  { id: 'wand', out: 'wand', count: 1, station: 'bench', needs: [['gold_ingot', 1], [GLASS, 1], ['stick', 2]], note: 'Extends a surface you point at' },
  { id: 'concrete', out: CONCRETE, count: 4, station: 'bench', needs: [[GRAVEL, 3], [SAND, 1], ['coal', 1]] },

  // --- guns and ammunition -----------------------------------------------
  { id: 'gunpowder', out: 'gunpowder', count: 2, station: 'bench', needs: [['coal', 1], [SAND, 1]] },
  { id: 'ammo_light', out: 'ammo_light', count: 16, station: 'bench', needs: [['copper_ingot', 1], ['gunpowder', 1]] },
  { id: 'ammo_heavy', out: 'ammo_heavy', count: 12, station: 'bench', needs: [['iron_ingot', 1], ['gunpowder', 1]] },
  { id: 'shells', out: 'shells', count: 8, station: 'bench', needs: [['copper_ingot', 1], ['gunpowder', 2]] },
  { id: 'pistol', out: 'pistol', count: 1, station: 'bench', needs: [['iron_ingot', 3], ['copper_ingot', 1], ['stick', 1]] },
  { id: 'rifle', out: 'rifle', count: 1, station: 'bench', needs: [['iron_ingot', 5], ['copper_ingot', 1], [PLANKS, 2]] },
  { id: 'shotgun', out: 'shotgun', count: 1, station: 'bench', needs: [['iron_ingot', 4], ['copper_ingot', 2], [PLANKS, 2]] },
];

/** Can this recipe be made from `have`, and at the station you are standing at? */
export function canCraft(recipe, have, stations) {
  if (recipe.station && !stations.has(recipe.station)) return false;
  for (const [id, n] of recipe.needs) if ((have[id] || 0) < n) return false;
  return true;
}

/** Which ingredients are short, for showing the player what to go and find. */
export function missing(recipe, have) {
  const out = [];
  for (const [id, n] of recipe.needs) {
    const got = have[id] || 0;
    if (got < n) out.push({ id, need: n, got });
  }
  return out;
}

/** Take the ingredients and give back the result. */
export function craft(recipe, inventory) {
  const have = inventory.tally();
  for (const [id, n] of recipe.needs) if ((have[id] || 0) < n) return false;
  for (const [id, n] of recipe.needs) inventory.remove(id, n);
  const leftover = inventory.add(recipe.out, recipe.count);
  return leftover === 0;
}
