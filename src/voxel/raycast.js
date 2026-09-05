// Walking a ray through the grid, one block at a time.

import { AIR, BLOCKS } from './blocks.js';

/**
 * The first block a ray hits, by Amanatides and Woo's traversal.
 *
 * Stepping cell by cell rather than sampling along the ray matters for
 * building: a sampled ray skips a block it grazes, and the face you get back
 * is whichever sample happened to land inside, so a wall placed against a
 * corner ends up one block off. Stepping gives the exact face crossed.
 *
 * Returns { x, y, z, nx, ny, nz, id, distance } or null.
 */
export function raycastVoxels(grid, origin, direction, maxDistance = 6, hits = null) {
  const test = hits || ((id) => id !== AIR && !BLOCKS[id].liquid);

  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const dx = direction.x, dy = direction.y, dz = direction.z;
  if (dx === 0 && dy === 0 && dz === 0) return null;

  const stepX = Math.sign(dx), stepY = Math.sign(dy), stepZ = Math.sign(dz);
  // Distance along the ray between successive crossings of each axis' planes.
  const tDeltaX = stepX ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = stepY ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = stepZ ? Math.abs(1 / dz) : Infinity;
  // Distance to the first crossing of each.
  const boundary = (p, s) => (s > 0 ? Math.floor(p) + 1 - p : p - Math.floor(p));
  let tMaxX = stepX ? boundary(origin.x, stepX) * tDeltaX : Infinity;
  let tMaxY = stepY ? boundary(origin.y, stepY) * tDeltaY : Infinity;
  let tMaxZ = stepZ ? boundary(origin.z, stepZ) * tDeltaZ : Infinity;

  let nx = 0, ny = 0, nz = 0, t = 0;

  // The ray can start inside a block when you are stood in tall grass or have
  // clipped a corner; check where it begins before stepping.
  const first = grid.get(x, y, z);
  if (test(first)) return { x, y, z, nx: 0, ny: 1, nz: 0, id: first, distance: 0 };

  for (let guard = 0; guard < 512; guard++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX; nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY; nx = 0; ny = -stepY; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; nx = 0; ny = 0; nz = -stepZ;
    }
    if (t > maxDistance) return null;
    const id = grid.get(x, y, z);
    if (test(id)) return { x, y, z, nx, ny, nz, id, distance: t };
  }
  return null;
}
