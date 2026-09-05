// Three.js half of restaurant media enrichment. Kept separate from the API
// parsers so their identity/licence rules remain directly testable in Node.

import * as THREE from 'three';
import { restaurantMediaPlacement } from './restaurant-media.js';

function quadGeometry(target, width, height, alongOffset, centreY) {
  const [ax, az] = target.right;
  const [nx, nz] = target.normal;
  const cx = target.x + nx * target.depth + ax * alongOffset;
  const cz = target.z + nz * target.depth + az * alongOffset;
  const hw = width / 2, hh = height / 2;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    cx - ax * hw, centreY - hh, cz - az * hw,
    cx + ax * hw, centreY - hh, cz + az * hw,
    cx + ax * hw, centreY + hh, cz + az * hw,
    cx - ax * hw, centreY + hh, cz - az * hw,
  ], 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute([
    nx, 0, nz, nx, 0, nz, nx, 0, nz, nx, 0, nz,
  ], 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
    // decodeImage normally returns ImageBitmap. Browsers ignore WebGL's
    // UNPACK_FLIP_Y flag for ImageBitmap, so encode the DOM-image top-left
    // origin explicitly in the quad and leave Texture.flipY disabled.
    0, 1, 1, 1, 1, 0, 0, 0,
  ], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeBoundingSphere();
  return geometry;
}

/** Build the small, separately materialled real-media panel for one facade. */
export function makeRestaurantMediaMesh(media, target) {
  if (!media?.image || !target) return null;
  const placement = restaurantMediaPlacement(media, target);
  if (!placement) return null;
  const texture = new THREE.Texture(media.image);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  const material = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0xffffff,
    transparent: true,
    alphaTest: media.kind === 'logo' ? 0.04 : 0,
    roughness: 0.72,
    metalness: 0,
    side: THREE.FrontSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const geometry = quadGeometry(target, placement.width, placement.height,
                                placement.alongOffset, placement.centreY);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `restaurant-media:${target.restaurant.name || target.restaurant.id || 'unnamed'}`;
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  mesh.userData.ownedRestaurantMedia = true;
  mesh.userData.restaurantMedia = media;
  return mesh;
}

export function disposeRestaurantMedia(mesh) {
  if (!mesh) return;
  const image = mesh.material?.map?.image;
  if (mesh.geometry) mesh.geometry.dispose();
  if (mesh.material?.map) mesh.material.map.dispose();
  if (mesh.material) mesh.material.dispose();
  if (image && typeof image.close === 'function') image.close();
}
