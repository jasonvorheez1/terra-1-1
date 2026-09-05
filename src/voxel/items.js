// Everything you can hold: blocks, materials, tools, weapons.
//
// Blocks and items share one namespace of string ids. A block is just an item
// that happens to have somewhere to go when you right-click, which means the
// hotbar, the inventory and the recipe table never have to care which is which.

import { BLOCKS } from './blocks.js';

/** Tool families. A block names the one that yields to it. */
export const TOOLS = ['pickaxe', 'axe', 'shovel'];

/**
 * Tool tiers, and what they can bring home.
 *
 * Tier gates the drop rather than the dig: a wooden pickaxe will happily break
 * iron ore and leave you with nothing, which is the thing that sends you back
 * down for more coal instead of straight to the good stuff.
 */
const TIER = { wood: 1, stone: 2, iron: 3, gold: 4 };

const M = (name, extra = {}) => ({ name, kind: 'material', stack: 64, ...extra });

export const ITEMS = {
  // --- materials ---------------------------------------------------------
  stick: M('Stick', { colour: '#9a7846' }),
  coal: M('Coal', { colour: '#231f1c' }),
  iron_ore: M('Iron ore', { colour: '#c08a63' }),
  copper_ore: M('Copper ore', { colour: '#5aa88a' }),
  gold_ore: M('Gold ore', { colour: '#e8c04a' }),
  iron_ingot: M('Iron ingot', { colour: '#d8d4cc' }),
  copper_ingot: M('Copper ingot', { colour: '#c47a4a' }),
  gold_ingot: M('Gold ingot', { colour: '#f0cf5a' }),
  gunpowder: M('Gunpowder', { colour: '#4a4a52' }),

  // --- ammunition --------------------------------------------------------
  ammo_light: M('Light rounds', { kind: 'ammo', colour: '#c9a86a' }),
  ammo_heavy: M('Heavy rounds', { kind: 'ammo', colour: '#b08040' }),
  shells: M('Shotgun shells', { kind: 'ammo', colour: '#a8443a' }),

  // --- digging tools -----------------------------------------------------
  // `speed` multiplies how fast the matching family comes apart; `reach` and
  // `durability` are the cost of using it.
  pickaxe_wood: tool('Wooden pickaxe', 'pickaxe', TIER.wood, 2.5, 60, '#9a7846'),
  pickaxe_stone: tool('Stone pickaxe', 'pickaxe', TIER.stone, 4.5, 130, '#8a8a8a'),
  pickaxe_iron: tool('Iron pickaxe', 'pickaxe', TIER.iron, 7.5, 320, '#d8d4cc'),
  shovel_wood: tool('Wooden shovel', 'shovel', TIER.wood, 2.5, 60, '#9a7846'),
  shovel_stone: tool('Stone shovel', 'shovel', TIER.stone, 4.5, 130, '#8a8a8a'),
  shovel_iron: tool('Iron shovel', 'shovel', TIER.iron, 7.5, 320, '#d8d4cc'),
  axe_wood: tool('Wooden axe', 'axe', TIER.wood, 2.5, 60, '#9a7846'),
  axe_stone: tool('Stone axe', 'axe', TIER.stone, 4.5, 130, '#8a8a8a'),
  axe_iron: tool('Iron axe', 'axe', TIER.iron, 7.5, 320, '#d8d4cc'),

  // --- melee -------------------------------------------------------------
  // No creature in this world has anything to fear from a blade, so a melee
  // weapon earns its place by what it does to the terrain instead: the machete
  // clears undergrowth in one swing, the sledgehammer takes out a wall.
  machete: {
    name: 'Machete', kind: 'weapon', stack: 1, colour: '#b8c0c8',
    melee: { swing: 0.22, power: 3, shears: true }, durability: 250,
  },
  sledgehammer: {
    name: 'Sledgehammer', kind: 'weapon', stack: 1, colour: '#7a7a80',
    melee: { swing: 0.62, power: 2.2, area: 1 }, tool: 'pickaxe', tier: TIER.stone,
    durability: 400,
  },

  // --- guns --------------------------------------------------------------
  // Hitscan, and what they hit is the world: a round takes a bite out of the
  // blocks it lands in. That makes a gun a demolition tool with recoil, which
  // is the only honest thing for it to be in a world with nothing living in it.
  pistol: gun('Pistol', 'ammo_light', { rpm: 320, dig: 0.8, range: 60, spread: 0.010, recoil: 0.020 }, '#6a6a72'),
  rifle: gun('Rifle', 'ammo_heavy', { rpm: 140, dig: 1.4, range: 220, spread: 0.002, recoil: 0.055 }, '#5a4a3a'),
  shotgun: gun('Shotgun', 'shells', { rpm: 70, dig: 1.1, range: 28, spread: 0.075, pellets: 8, recoil: 0.090 }, '#7a4a3a'),

  // --- base building -----------------------------------------------------
  wand: {
    name: "Builder's wand", kind: 'tool', stack: 1, colour: '#f0cf5a',
    wand: { max: 12 }, durability: 500,
  },
};

function tool(name, family, tier, speed, durability, colour) {
  return { name, kind: 'tool', stack: 1, tool: family, tier, speed, durability, colour };
}

function gun(name, ammo, spec, colour) {
  return {
    name, kind: 'gun', stack: 1, colour,
    gun: { pellets: 1, ...spec, ammo },
  };
}

// --- blocks as items -------------------------------------------------------

/** Colour shown in the hotbar for a block, matching its texture. */
const BLOCK_COLOUR = {
  1: '#8a8a8a', 2: '#7a5a3c', 3: '#6aa03c', 4: '#dcd0a0', 5: '#8d8880',
  6: '#f2f6fa', 7: '#6d5334', 8: '#3f6b2a', 9: '#b08a55', 10: '#6f6f6f',
  11: '#96604d', 12: 'rgba(210,232,244,0.6)', 13: '#306896', 14: '#b9b7b0',
  15: '#3f4145', 16: '#9aa0ab', 17: '#3a3430', 18: '#c08a63', 19: '#5aa88a',
  20: '#e8c04a', 21: '#b08a55', 22: '#6f6f6f',
};

/** Item id for a block id, e.g. 3 -> 'block_grass'. */
export const blockItem = (id) => 'block_' + id;

for (const b of BLOCKS) {
  if (b.id === 0 || b.id === 13) continue;                 // air and water
  ITEMS[blockItem(b.id)] = {
    name: b.name, kind: 'block', stack: 64, block: b.id,
    colour: BLOCK_COLOUR[b.id] || '#a0a0a0',
  };
}

// Ores drop their material rather than the rock they came in, so the block
// item exists for building with but is not what mining gives you.
for (const b of BLOCKS) {
  if (b.item) ITEMS[blockItem(b.id)].dropsAs = b.item;
}

export function item(id) { return ITEMS[id] || null; }
export function itemName(id) { const i = ITEMS[id]; return i ? i.name : id; }
export function itemColour(id) { const i = ITEMS[id]; return i ? (i.colour || '#a0a0a0') : '#a0a0a0'; }
export function stackSize(id) { const i = ITEMS[id]; return i ? (i.stack || 64) : 64; }
export function isTool(id) { const i = ITEMS[id]; return !!(i && (i.kind === 'tool' || i.kind === 'weapon')); }
export function maxDurability(id) { const i = ITEMS[id]; return i ? (i.durability || 0) : 0; }

/**
 * What a block gives you when it is mined with this tool.
 * Null means the tool was too soft and the block is simply destroyed.
 */
export function dropFor(block, heldId) {
  if (block.needs > 0) {
    const held = ITEMS[heldId];
    const tier = held && held.tool === block.tool ? held.tier : (held && held.tier) || 0;
    if (tier < block.needs) return null;
  }
  if (block.item) return block.item;
  return blockItem(block.drops);
}

/**
 * How much faster than bare hands this item breaks that block.
 *
 * The wrong tool is not merely slower - swinging a pickaxe at a tree should
 * feel like the wrong idea - so anything that does not match the family gets
 * no bonus at all, and a bare hand is the baseline of 1.
 */
export function digSpeed(block, heldId) {
  const held = ITEMS[heldId];
  if (!held) return 1;
  if (held.melee) {
    // A blade is quick through anything soft and useless against rock.
    if (held.melee.shears && (block.tool === 'axe' || block.hardness <= 0.7)) return held.melee.power * 2;
    if (held.tool && held.tool === block.tool) return held.melee.power;
    return held.melee.power * 0.5;
  }
  if (!held.tool || held.tool !== block.tool) return 1;
  return held.speed || 1;
}
