// Turning a chunk of blocks into geometry.
//
// Only faces with nothing opaque in front of them are emitted, so the cost is
// the surface area of the terrain rather than its volume - the rock under a
// hillside is stored but never drawn until you dig into it.

import * as THREE from 'three';
import { AIR, BLOCKS, isCulling, isSolid, isTranslucent, tileUv } from './blocks.js';
import { MeshBVH } from 'three-mesh-bvh';
import { CHUNK, HEIGHT } from './grid.js';

// Cube corner offsets per face, wound counter-clockwise seen from outside, and
// always bottom-bottom-top-top so a side texture is never upside down.
const FACES = [
  { // +X
    normal: [1, 0, 0], u: 2, v: 1,
    corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
  },
  { // -X
    normal: [-1, 0, 0], u: 2, v: 1,
    corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]],
  },
  { // +Y
    normal: [0, 1, 0], u: 0, v: 2,
    corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  },
  { // -Y
    normal: [0, -1, 0], u: 0, v: 2,
    corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  },
  { // +Z
    normal: [0, 0, 1], u: 0, v: 1,
    corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]],
  },
  { // -Z
    normal: [0, 0, -1], u: 0, v: 1,
    corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  },
];

// How much light a face of each orientation gets before the sun is considered.
// Real lighting still runs over the top of this; the constant is what stops a
// cube reading as a flat silhouette when the sun is directly overhead and
// every side face has the same grazing angle.
const FACE_SHADE = [0.80, 0.80, 1.0, 0.55, 0.88, 0.88];

// Vertex brightness by how boxed-in the corner is. The step from 3 to 0 is the
// soft dark seam in every inside corner, and it is most of what makes a blocky
// world read as having depth at all.
const AO_LEVEL = [0.46, 0.66, 0.84, 1.0];

class Buffers {
  constructor() {
    this.pos = [];
    this.norm = [];
    this.uv = [];
    this.col = [];
    this.idx = [];
    this.count = 0;
    this.surf = [];        // footstep surface, per triangle
  }

  quad(ox, oy, oz, face, uvRect, ao, shade, surface) {
    const { corners, normal } = face;
    const base = this.count;
    // The four UV corners, in the same order as the vertices: bottom-left,
    // top-left, top-right, bottom-right.
    const uvs = [
      uvRect.u0, uvRect.v0, uvRect.u0, uvRect.v1,
      uvRect.u1, uvRect.v1, uvRect.u1, uvRect.v0,
    ];
    for (let k = 0; k < 4; k++) {
      const c = corners[k];
      this.pos.push(ox + c[0], oy + c[1], oz + c[2]);
      this.norm.push(normal[0], normal[1], normal[2]);
      this.uv.push(uvs[k * 2], uvs[k * 2 + 1]);
      const b = AO_LEVEL[ao[k]] * shade;
      this.col.push(b, b, b);
    }
    // Split the quad along the darker diagonal. Triangulating it the other way
    // makes a corner's shadow bend the wrong side of the square and flicker as
    // you walk past, which is the classic voxel AO artefact.
    if (ao[0] + ao[2] > ao[1] + ao[3]) {
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    } else {
      this.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    }
    this.surf.push(surface, surface);
    this.count += 4;
  }

  get isEmpty() { return this.idx.length === 0; }

  /**
   * The same triangles with nothing but positions, for the collider.
   *
   * Vertices are already in world coordinates, which is what the collision
   * world expects - every other collider in the game is built that way, and
   * the capsule sweep never transforms into a mesh's local space.
   */
  collider(name) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    const Index = this.count > 65535 ? Uint32Array : Uint16Array;
    g.setIndex(new THREE.BufferAttribute(new Index(this.idx), 1));
    g.computeBoundingBox();
    g.boundsTree = new MeshBVH(g, { strategy: 1, maxLeafTris: 8 });
    const mesh = new THREE.Mesh(g);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrixWorld(true);
    // Footstep audio reads a surface id per triangle; without one every
    // block sounds like the default.
    mesh.userData.surfaces = Uint8Array.from(this.surf);
    return mesh;
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setIndex(this.idx);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Mesh one chunk.
 *
 * Three streams come out: the opaque blocks, glass, and water. They are
 * separate because glass and water must not hide what is behind them and have
 * to be drawn after everything else, and because water is the only one of the
 * three you can walk into - keeping it apart means the collider can simply
 * ignore that geometry rather than having to know about block types.
 */
export function meshChunk(grid, chunk) {
  const opaque = new Buffers(), glass = new Buffers(), water = new Buffers();
  const ox0 = chunk.cx * CHUNK, oz0 = chunk.cz * CHUNK, oy0 = grid.baseY;
  const data = chunk.data;

  // Neighbour lookup with a fast path for the 14 of every 16 columns that do
  // not touch a seam; only the border needs to go through the grid's map.
  const at = (lx, ly, lz) => {
    if (ly < 0 || ly >= HEIGHT) return AIR;
    if (lx >= 0 && lx < CHUNK && lz >= 0 && lz < CHUNK) {
      return data[(ly * CHUNK + lz) * CHUNK + lx];
    }
    return grid.get(ox0 + lx, grid.baseY + ly, oz0 + lz);
  };
  const occludes = (lx, ly, lz) => isSolid(at(lx, ly, lz));

  for (let ly = 0; ly < HEIGHT; ly++) {
    for (let lz = 0; lz < CHUNK; lz++) {
      for (let lx = 0; lx < CHUNK; lx++) {
        const id = data[(ly * CHUNK + lz) * CHUNK + lx];
        if (id === AIR) continue;
        const block = BLOCKS[id];
        const target = block.liquid ? water : (block.translucent ? glass : opaque);

        for (let f = 0; f < 6; f++) {
          const face = FACES[f];
          const nx = lx + face.normal[0], ny = ly + face.normal[1], nz = lz + face.normal[2];
          const neighbour = at(nx, ny, nz);
          if (neighbour === id) continue;             // no seam inside water
          if (isCulling(neighbour)) continue;

          // Ambient occlusion: for each vertex, how much of the corner beyond
          // this face is filled in.
          const ao = [0, 0, 0, 0];
          for (let k = 0; k < 4; k++) {
            const c = face.corners[k];
            const su = (c[face.u] ? 1 : -1);
            const sv = (c[face.v] ? 1 : -1);
            const d1 = [0, 0, 0], d2 = [0, 0, 0];
            d1[face.u] = su;
            d2[face.v] = sv;
            const s1 = occludes(nx + d1[0], ny + d1[1], nz + d1[2]) ? 1 : 0;
            const s2 = occludes(nx + d2[0], ny + d2[1], nz + d2[2]) ? 1 : 0;
            // Two filled sides seal the corner however the diagonal sits.
            if (s1 && s2) { ao[k] = 0; continue; }
            const cn = occludes(nx + d1[0] + d2[0], ny + d1[1] + d2[1], nz + d1[2] + d2[2]) ? 1 : 0;
            ao[k] = 3 - (s1 + s2 + cn);
          }

          const tile = f === 2 ? block.top : (f === 3 ? block.bottom : block.side);
          target.quad(ox0 + lx, oy0 + ly, oz0 + lz, face, tileUv(tile), ao, FACE_SHADE[f],
                      block.footstep);
        }
      }
    }
  }

  return { opaque, glass, water };
}

export { isTranslucent };
